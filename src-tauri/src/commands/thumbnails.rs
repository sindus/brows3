use crate::commands::profiles::ProfileState;
use crate::s3::S3State;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::PathBuf;
use base64::Engine;

const THUMB_SIZE: u32 = 200;
const DEFAULT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "svg", "ico",
];

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts",
    "wmv", "flv", "3gp",
];

fn is_image(key: &str) -> bool {
    let lower = key.to_lowercase();
    IMAGE_EXTENSIONS.iter().any(|ext| lower.ends_with(&format!(".{}", ext)))
}

fn is_video_ext(key: &str) -> bool {
    let lower = key.to_lowercase();
    VIDEO_EXTENSIONS.iter().any(|ext| lower.ends_with(&format!(".{}", ext)))
}

fn is_video_content_type(ct: &str) -> bool {
    ct.starts_with("video/")
}

// ─── Cache paths ────────────────────────────────────────────────────────────

fn cache_root(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("thumbnails"))
}

fn manifest_path(app: &AppHandle) -> Option<PathBuf> {
    Some(cache_root(app)?.join("manifest.json"))
}

fn thumb_path(app: &AppHandle, profile_id: &str, bucket: &str, key: &str) -> Option<PathBuf> {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    let dir = cache_root(app)?
        .join(profile_id)
        .join(bucket);
    Some(dir.join(format!("{}.jpg", hash)))
}

// ─── Manifest ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CacheEntry {
    path: String,         // absolute path on disk
    size_bytes: u64,
    last_accessed: u64,   // unix timestamp (seconds)
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheManifest {
    total_size_bytes: u64,
    entries: Vec<CacheEntry>,
}

impl CacheManifest {
    fn empty() -> Self {
        CacheManifest { total_size_bytes: 0, entries: Vec::new() }
    }
}

async fn load_manifest(path: &PathBuf) -> CacheManifest {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(t) => t,
        Err(_) => return CacheManifest::empty(),
    };
    serde_json::from_str(&text).unwrap_or_else(|_| CacheManifest::empty())
}

async fn save_manifest(path: &PathBuf, manifest: &CacheManifest) {
    if let Ok(json) = serde_json::to_string(manifest) {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let _ = tokio::fs::write(path, json).await;
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Record a newly written thumbnail and evict LRU entries if over limit.
async fn record_thumbnail(app: &AppHandle, path: &PathBuf, size_bytes: u64, limit_bytes: u64) {
    let mpath = match manifest_path(app) {
        Some(p) => p,
        None => return,
    };
    let mut manifest = load_manifest(&mpath).await;
    let path_str = path.to_string_lossy().to_string();

    // Update existing entry or push new one
    if let Some(entry) = manifest.entries.iter_mut().find(|e| e.path == path_str) {
        manifest.total_size_bytes -= entry.size_bytes;
        entry.size_bytes = size_bytes;
        entry.last_accessed = now_secs();
        manifest.total_size_bytes += size_bytes;
    } else {
        manifest.total_size_bytes += size_bytes;
        manifest.entries.push(CacheEntry {
            path: path_str,
            size_bytes,
            last_accessed: now_secs(),
        });
    }

    // Evict LRU entries while over limit
    if manifest.total_size_bytes > limit_bytes {
        // Sort oldest first
        manifest.entries.sort_by_key(|e| e.last_accessed);
        while manifest.total_size_bytes > limit_bytes && !manifest.entries.is_empty() {
            let victim = manifest.entries.remove(0);
            if tokio::fs::remove_file(&victim.path).await.is_ok() {
                manifest.total_size_bytes =
                    manifest.total_size_bytes.saturating_sub(victim.size_bytes);
            }
        }
    }

    save_manifest(&mpath, &manifest).await;
}

/// Update the last_accessed timestamp for a cache hit (no size change).
async fn touch_entry(app: &AppHandle, path: &PathBuf) {
    let mpath = match manifest_path(app) {
        Some(p) => p,
        None => return,
    };
    let mut manifest = load_manifest(&mpath).await;
    let path_str = path.to_string_lossy().to_string();
    if let Some(entry) = manifest.entries.iter_mut().find(|e| e.path == path_str) {
        entry.last_accessed = now_secs();
        save_manifest(&mpath, &manifest).await;
    }
}

// ─── State ──────────────────────────────────────────────────────────────────

pub struct ThumbnailState {
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub limit_bytes: Mutex<u64>,
}

impl ThumbnailState {
    pub fn new() -> Self {
        ThumbnailState {
            cancel: Mutex::new(None),
            limit_bytes: Mutex::new(DEFAULT_LIMIT_BYTES),
        }
    }
}

// ─── Events ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailReady {
    pub key: String,
    pub data: String, // base64 JPEG
}

// ─── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn start_thumbnail_generation(
    bucket: String,
    bucket_region: Option<String>,
    keys: Vec<String>,
    app: AppHandle,
    profile_state: State<'_, ProfileState>,
    s3_state: State<'_, S3State>,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    // Cancel any existing generation
    {
        let mut guard = thumb_state.cancel.lock().unwrap();
        if let Some(old) = guard.take() {
            old.store(true, Ordering::Relaxed);
        }
        *guard = Some(Arc::new(AtomicBool::new(false)));
    }
    let cancel = thumb_state.cancel.lock().unwrap().clone().unwrap();
    let limit = *thumb_state.limit_bytes.lock().unwrap();

    let profile = {
        let pm = profile_state.read().await;
        pm.get_active_profile().await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active profile".to_string())?
    };
    let profile_id = profile.id.clone();

    let client = {
        let mut s3 = s3_state.write().await;
        s3.get_client(&profile).await.map_err(|e| e.to_string())?.clone()
    };

    let region = bucket_region.or_else(|| {
        s3_state.try_read().ok().and_then(|s| s.get_bucket_region(&bucket))
    });
    let _ = region; // used indirectly via client config

    let app_clone = app.clone();
    let bucket_clone = bucket.clone();

    tokio::spawn(async move {
        let image_keys: Vec<String> = keys.into_iter().filter(|k| is_image(k)).collect();

        for key in image_keys {
            if cancel.load(Ordering::Relaxed) { break; }

            let path = match thumb_path(&app_clone, &profile_id, &bucket_clone, &key) {
                Some(p) => p,
                None => continue,
            };

            // ── Cache hit ──
            let data = if path.exists() {
                match tokio::fs::read(&path).await {
                    Ok(bytes) => {
                        touch_entry(&app_clone, &path).await;
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    }
                    Err(_) => continue,
                }
            } else {
                // ── Cache miss: download + compress ──
                if cancel.load(Ordering::Relaxed) { break; }

                let resp = match client
                    .get_object()
                    .bucket(&bucket_clone)
                    .key(&key)
                    .send()
                    .await
                {
                    Ok(r) => r,
                    Err(_) => continue,
                };

                let ct = resp.content_type().unwrap_or("").to_lowercase();

                // ── Video: use ffmpeg sidecar via presigned URL ──
                let thumb_bytes = if is_video_ext(&key) || is_video_content_type(&ct) {
                    // Drop the open response body before generating presigned URL
                    drop(resp);
                    if cancel.load(Ordering::Relaxed) { break; }

                    let presigned = match client
                        .get_object()
                        .bucket(&bucket_clone)
                        .key(&key)
                        .presigned(
                            aws_sdk_s3::presigning::PresigningConfig::expires_in(
                                std::time::Duration::from_secs(300),
                            ).unwrap()
                        )
                        .await
                    {
                        Ok(p) => p,
                        Err(_) => continue,
                    };

                    match generate_video_thumbnail(&app_clone, presigned.uri()).await {
                        Some(b) => b,
                        None => continue,
                    }
                } else {
                    // ── Image: check content-type then decode bytes ──
                    if !ct.is_empty() && !ct.starts_with("image/") {
                        continue; // explicitly not an image
                    }

                    if cancel.load(Ordering::Relaxed) { break; }

                    let bytes = match resp.body.collect().await {
                        Ok(b) => b.into_bytes(),
                        Err(_) => continue,
                    };

                    if cancel.load(Ordering::Relaxed) { break; }

                    match generate_thumbnail(&bytes) {
                        Some(b) => b,
                        None => continue,
                    }
                };

                let size = thumb_bytes.len() as u64;

                if let Some(parent) = path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&path, &thumb_bytes).await;

                record_thumbnail(&app_clone, &path, size, limit).await;

                base64::engine::general_purpose::STANDARD.encode(&thumb_bytes)
            };

            if cancel.load(Ordering::Relaxed) { break; }

            let _ = app_clone.emit("thumbnail_ready", ThumbnailReady { key, data });
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_thumbnail_generation(
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    let mut guard = thumb_state.cancel.lock().unwrap();
    if let Some(flag) = guard.take() {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CacheInfo {
    pub total_size_bytes: u64,
    pub limit_bytes: u64,
    pub entry_count: usize,
}

#[tauri::command]
pub async fn get_cache_info(
    app: AppHandle,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<CacheInfo, String> {
    let mpath = manifest_path(&app).ok_or("No cache dir")?;
    let manifest = load_manifest(&mpath).await;
    let limit = *thumb_state.limit_bytes.lock().unwrap();
    Ok(CacheInfo {
        total_size_bytes: manifest.total_size_bytes,
        limit_bytes: limit,
        entry_count: manifest.entries.len(),
    })
}

#[tauri::command]
pub async fn clear_thumbnail_cache(
    app: AppHandle,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    // Cancel ongoing generation first
    {
        let mut guard = thumb_state.cancel.lock().unwrap();
        if let Some(flag) = guard.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }

    if let Some(root) = cache_root(&app) {
        if root.exists() {
            tokio::fs::remove_dir_all(&root).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_cache_limit(
    limit_bytes: u64,
    app: AppHandle,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    {
        let mut guard = thumb_state.limit_bytes.lock().unwrap();
        *guard = limit_bytes;
    }

    // Immediately enforce the new (possibly lower) limit
    let mpath = manifest_path(&app).ok_or("No cache dir")?;
    let mut manifest = load_manifest(&mpath).await;
    if manifest.total_size_bytes > limit_bytes {
        manifest.entries.sort_by_key(|e| e.last_accessed);
        while manifest.total_size_bytes > limit_bytes && !manifest.entries.is_empty() {
            let victim = manifest.entries.remove(0);
            if tokio::fs::remove_file(&victim.path).await.is_ok() {
                manifest.total_size_bytes =
                    manifest.total_size_bytes.saturating_sub(victim.size_bytes);
            }
        }
        save_manifest(&mpath, &manifest).await;
    }
    Ok(())
}

// ─── Image processing ───────────────────────────────────────────────────────

fn generate_thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let thumb = img.thumbnail(THUMB_SIZE, THUMB_SIZE);
    let mut out = Vec::new();
    thumb.write_to(
        &mut std::io::Cursor::new(&mut out),
        image::ImageFormat::Jpeg,
    ).ok()?;
    Some(out)
}

// ─── Video processing ───────────────────────────────────────────────────────

async fn generate_video_thumbnail(app: &AppHandle, presigned_url: &str) -> Option<Vec<u8>> {
    use tauri_plugin_shell::ShellExt;

    let output = app
        .shell()
        .sidecar("brows3-ffmpeg")
        .ok()?
        .args([
            "-y",
            "-i", presigned_url,
            "-ss", "00:00:01",
            "-frames:v", "1",
            "-vf", &format!("scale={}:{}:force_original_aspect_ratio=decrease", THUMB_SIZE, THUMB_SIZE),
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
        ])
        .output()
        .await
        .ok()?;

    if output.status.success() && !output.stdout.is_empty() {
        Some(output.stdout)
    } else {
        None
    }
}
