use crate::commands::profiles::ProfileState;
use crate::s3::S3State;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const THUMB_SIZE: u32 = 400;
const JPEG_QUALITY: u8 = 85;
const DEFAULT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "svg", "ico",
];

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "wmv", "flv", "3gp",
];

fn is_image(key: &str) -> bool {
    let lower = key.to_lowercase();
    IMAGE_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{}", ext)))
}

fn is_video_ext(key: &str) -> bool {
    let lower = key.to_lowercase();
    VIDEO_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(&format!(".{}", ext)))
}

// ─── Cache paths ────────────────────────────────────────────────────────────

fn cache_root(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("thumbnails"))
}

fn manifest_path(app: &AppHandle) -> Option<PathBuf> {
    Some(cache_root(app)?.join("manifest.json"))
}

fn cache_file_path(
    app: &AppHandle,
    profile_id: &str,
    bucket: &str,
    key: &str,
    ext: &str,
) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    Some(
        cache_root(app)?
            .join(profile_id)
            .join(bucket)
            .join(format!("{}.{}", hash, ext)),
    )
}

fn thumb_path(app: &AppHandle, profile_id: &str, bucket: &str, key: &str) -> Option<PathBuf> {
    cache_file_path(app, profile_id, bucket, key, "jpg")
}

fn preview_path(app: &AppHandle, profile_id: &str, bucket: &str, key: &str) -> Option<PathBuf> {
    cache_file_path(app, profile_id, bucket, key, "webp")
}

// ─── Manifest ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CacheEntry {
    path: String, // absolute path on disk
    size_bytes: u64,
    last_accessed: u64, // unix timestamp (seconds)
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheManifest {
    total_size_bytes: u64,
    entries: Vec<CacheEntry>,
}

impl CacheManifest {
    fn empty() -> Self {
        CacheManifest {
            total_size_bytes: 0,
            entries: Vec::new(),
        }
    }
}

async fn load_manifest(path: &Path) -> CacheManifest {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(t) => t,
        Err(_) => return CacheManifest::empty(),
    };
    serde_json::from_str(&text).unwrap_or_else(|_| CacheManifest::empty())
}

async fn save_manifest(path: &Path, manifest: &CacheManifest) {
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
async fn record_thumbnail(app: &AppHandle, path: &Path, size_bytes: u64, limit_bytes: u64) {
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
async fn touch_entry(app: &AppHandle, path: &Path) {
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

impl Default for ThumbnailState {
    fn default() -> Self {
        Self::new()
    }
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

#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailPreviewReady {
    pub key: String,
    pub data: String, // base64 animated WebP
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
        pm.get_active_profile()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active profile".to_string())?
    };
    let profile_id = profile.id.clone();

    let client = {
        let mut s3 = s3_state.write().await;
        s3.get_client(&profile)
            .await
            .map_err(|e| e.to_string())?
            .clone()
    };

    let region = bucket_region.or_else(|| {
        s3_state
            .try_read()
            .ok()
            .and_then(|s| s.get_bucket_region(&bucket))
    });
    let _ = region; // used indirectly via client config

    let app_clone = app.clone();
    let bucket_clone = bucket.clone();

    tokio::spawn(async move {
        let keys_to_process: Vec<String> = keys
            .into_iter()
            .filter(|k| is_image(k) || is_video_ext(k))
            .collect();

        for key in keys_to_process {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let path = match thumb_path(&app_clone, &profile_id, &bucket_clone, &key) {
                Some(p) => p,
                None => continue,
            };

            // ── Video: produce JPEG static + animated WebP independently ──
            if is_video_ext(&key) {
                let pp = match preview_path(&app_clone, &profile_id, &bucket_clone, &key) {
                    Some(p) => p,
                    None => continue,
                };

                // Read both caches
                let jpeg_data = if path.exists() {
                    match tokio::fs::read(&path).await {
                        Ok(bytes) => {
                            touch_entry(&app_clone, &path).await;
                            Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
                        }
                        Err(_) => None,
                    }
                } else {
                    None
                };

                let preview_data = if pp.exists() {
                    match tokio::fs::read(&pp).await {
                        Ok(bytes) => {
                            touch_entry(&app_clone, &pp).await;
                            Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
                        }
                        Err(_) => None,
                    }
                } else {
                    None
                };

                // Emit whatever is already cached
                if let Some(ref d) = jpeg_data {
                    let _ = app_clone.emit(
                        "thumbnail_ready",
                        ThumbnailReady {
                            key: key.clone(),
                            data: d.clone(),
                        },
                    );
                }
                if let Some(ref d) = preview_data {
                    let _ = app_clone.emit(
                        "thumbnail_preview_ready",
                        ThumbnailPreviewReady {
                            key: key.clone(),
                            data: d.clone(),
                        },
                    );
                }
                if jpeg_data.is_some() && preview_data.is_some() {
                    continue;
                }

                // Need to generate one or both — get presigned URL
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let presigned = match client
                    .get_object()
                    .bucket(&bucket_clone)
                    .key(&key)
                    .presigned(
                        aws_sdk_s3::presigning::PresigningConfig::expires_in(
                            std::time::Duration::from_secs(300),
                        )
                        .unwrap(),
                    )
                    .await
                {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let url = presigned.uri().to_string();
                let duration = probe_video_duration(&app_clone, &url).await.unwrap_or(2.0);

                if jpeg_data.is_none() {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Some(bytes) =
                        generate_video_thumbnail(&app_clone, &url, duration / 2.0).await
                    {
                        let size = bytes.len() as u64;
                        if let Some(parent) = path.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        let _ = tokio::fs::write(&path, &bytes).await;
                        record_thumbnail(&app_clone, &path, size, limit).await;
                        let d = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let _ = app_clone.emit(
                            "thumbnail_ready",
                            ThumbnailReady {
                                key: key.clone(),
                                data: d,
                            },
                        );
                    }
                }

                if preview_data.is_none() {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Some(bytes) = generate_video_webp(&app_clone, &url, duration).await {
                        let size = bytes.len() as u64;
                        if let Some(parent) = pp.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        let _ = tokio::fs::write(&pp, &bytes).await;
                        record_thumbnail(&app_clone, &pp, size, limit).await;
                        let d = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let _ = app_clone.emit(
                            "thumbnail_preview_ready",
                            ThumbnailPreviewReady {
                                key: key.clone(),
                                data: d,
                            },
                        );
                    }
                }

                continue;
            }

            // ── Image: cache hit or miss ──
            let data = if path.exists() {
                match tokio::fs::read(&path).await {
                    Ok(bytes) => {
                        touch_entry(&app_clone, &path).await;
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    }
                    Err(_) => continue,
                }
            } else {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

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
                if !ct.is_empty() && !ct.starts_with("image/") {
                    continue;
                }

                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                let bytes = match resp.body.collect().await {
                    Ok(b) => b.into_bytes(),
                    Err(_) => continue,
                };

                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                let thumb_bytes = match generate_thumbnail(&bytes) {
                    Some(b) => b,
                    None => continue,
                };

                let size = thumb_bytes.len() as u64;
                if let Some(parent) = path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&path, &thumb_bytes).await;
                record_thumbnail(&app_clone, &path, size, limit).await;
                base64::engine::general_purpose::STANDARD.encode(&thumb_bytes)
            };

            if cancel.load(Ordering::Relaxed) {
                break;
            }
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
            tokio::fs::remove_dir_all(&root)
                .await
                .map_err(|e| e.to_string())?;
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
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops::FilterType;
    let img = image::load_from_memory(bytes).ok()?;
    let thumb = img.resize(THUMB_SIZE, THUMB_SIZE, FilterType::Lanczos3);
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    thumb.write_with_encoder(encoder).ok()?;
    Some(out)
}

// ─── Video processing ───────────────────────────────────────────────────────

fn parse_duration_from_stderr(stderr: &str) -> Option<f64> {
    for line in stderr.lines() {
        if let Some(pos) = line.find("Duration: ") {
            let rest = &line[pos + "Duration: ".len()..];
            let time_str: String = rest
                .chars()
                .take_while(|c| *c == ':' || *c == '.' || c.is_ascii_digit())
                .collect();
            let parts: Vec<&str> = time_str.splitn(3, ':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().ok()?;
                let m: f64 = parts[1].parse().ok()?;
                let s: f64 = parts[2].parse().ok()?;
                return Some(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    None
}

async fn probe_video_duration(app: &AppHandle, presigned_url: &str) -> Option<f64> {
    use tauri_plugin_shell::ShellExt;
    // Run ffmpeg with -i only (no output file) — exits 1 but writes "Duration: HH:MM:SS.cs" to stderr.
    // Only reads container headers so network overhead is minimal.
    let output = app
        .shell()
        .sidecar("brows3-ffmpeg")
        .ok()?
        .args(["-i", presigned_url])
        .output()
        .await
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_duration_from_stderr(&stderr)
}

// Extracts a single video frame as a decoded image (BMP → DynamicImage, no JPEG artifacts).
// BMP is lossless and its magic bytes (42 4d) are safe from pipe binary capture issues.
// Uses FFmpeg's lanczos filter for high-quality downscaling.
async fn extract_video_frame(
    app: &AppHandle,
    presigned_url: &str,
    seek_secs: f64,
) -> Option<image::DynamicImage> {
    use tauri_plugin_shell::ShellExt;
    let seek_str = format!("{:.3}", seek_secs);
    let vf = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos,format=bgr24",
        THUMB_SIZE, THUMB_SIZE
    );
    let output = app
        .shell()
        .sidecar("brows3-ffmpeg")
        .ok()?
        .args([
            "-y",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "2",
            "-ss",
            &seek_str,
            "-i",
            presigned_url,
            "-frames:v",
            "1",
            "-vf",
            &vf,
            "-f",
            "image2pipe",
            "-vcodec",
            "bmp",
            "pipe:1",
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    image::load_from_memory(&output.stdout).ok()
}

async fn generate_video_thumbnail(
    app: &AppHandle,
    presigned_url: &str,
    seek_secs: f64,
) -> Option<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;
    let img = extract_video_frame(app, presigned_url, seek_secs).await?;
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    img.write_with_encoder(encoder).ok()?;
    Some(out)
}

async fn generate_video_webp(
    app: &AppHandle,
    presigned_url: &str,
    duration: f64,
) -> Option<Vec<u8>> {
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;
    use tauri_plugin_shell::ShellExt;

    let t0 = 1.0_f64.min(duration * 0.05);
    let t1 = duration * 0.25;
    let t2 = duration * 0.5;
    let t3 = duration * 0.75;
    let t4 = (duration - 1.0).max(t3 + 0.1);

    // Extract 5 frames in parallel — same cost as a single sequential extraction.
    let (r0, r1, r2, r3, r4) = tokio::join!(
        extract_video_frame(app, presigned_url, t0),
        extract_video_frame(app, presigned_url, t1),
        extract_video_frame(app, presigned_url, t2),
        extract_video_frame(app, presigned_url, t3),
        extract_video_frame(app, presigned_url, t4),
    );

    let frames: Vec<image::DynamicImage> = [r0, r1, r2, r3, r4].into_iter().flatten().collect();
    if frames.is_empty() {
        return None;
    }

    // Write each frame as PNG in a unique temp dir, then have FFmpeg combine them into an
    // animated WebP. We go through PNG (lossless) so libwebp performs its own RGB→WebP
    // quantization once, instead of the per-frame 256-color palette quantization the Rust
    // `image` GifEncoder did. libwebp also supports millions of colors → no banding.
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    let temp_dir = std::env::temp_dir().join(format!("brows3_webp_{}_{}", std::process::id(), id));
    if tokio::fs::create_dir_all(&temp_dir).await.is_err() {
        return None;
    }

    let mut wrote_all = true;
    for (i, img) in frames.iter().enumerate() {
        let frame_path = temp_dir.join(format!("frame_{:03}.png", i));
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        let mut buf = Vec::new();
        let encoder = PngEncoder::new(&mut buf);
        if encoder
            .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
            .is_err()
            || tokio::fs::write(&frame_path, &buf).await.is_err()
        {
            wrote_all = false;
            break;
        }
    }

    let result = if wrote_all {
        let pattern = temp_dir.join("frame_%03d.png");
        let output_path = temp_dir.join("out.webp");
        let pattern_str = pattern.to_string_lossy().to_string();
        let output_str = output_path.to_string_lossy().to_string();

        let cmd_result = app
            .shell()
            .sidecar("brows3-ffmpeg")
            .ok()
            .map(|cmd| {
                cmd.args([
                    "-y",
                    "-framerate",
                    "2",
                    "-i",
                    &pattern_str,
                    "-c:v",
                    "libwebp",
                    "-preset",
                    "picture",
                    "-loop",
                    "0",
                    "-lossless",
                    "0",
                    "-quality",
                    "78",
                    "-compression_level",
                    "6",
                    "-an",
                    &output_str,
                ])
            })?
            .output()
            .await
            .ok();

        match cmd_result {
            Some(out) if out.status.success() => tokio::fs::read(&output_path).await.ok(),
            _ => None,
        }
    } else {
        None
    };

    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    result
}
