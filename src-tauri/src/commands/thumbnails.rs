//! Thumbnails for the grid view.
//!
//! The frontend starts a *generation* for the folder it shows, then enqueues the
//! objects that become visible. Each generation has its own id: events carry it,
//! and cancelling one never affects a newer one. Images are decoded with the
//! `image` crate; videos go through the bundled ffmpeg sidecar. Results are
//! written to an on-disk LRU cache and handed to the webview as file paths
//! (served through the asset protocol), never as base64 payloads.

use crate::commands::profiles::ProfileState;
use crate::s3::S3State;
use futures::channel::mpsc;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;

const THUMB_SIZE: u32 = 400;
const PREVIEW_SIZE: u32 = 320;
const JPEG_QUALITY: u8 = 85;
const DEFAULT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024; // 1 GiB
/// Larger images are not downloaded just to draw a 400 px thumbnail.
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
const CONCURRENCY: usize = 4;
const VIDEO_CONCURRENCY: usize = 2;
/// Previews asked for by a hover.
const PREVIEW_CONCURRENCY: usize = 2;
/// Previews built ahead of time for the videos on screen.
const PREFETCH_CONCURRENCY: usize = 1;
/// A failed object is not retried before this delay (unless it changes).
const FAILURE_RETRY: Duration = Duration::from_secs(24 * 3600);
const PRESIGN_TTL: Duration = Duration::from_secs(600);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const POSTER_TIMEOUT: Duration = Duration::from_secs(60);
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(120);
const PREVIEW_SEGMENTS: usize = 4;
const PREVIEW_SEGMENT_SECS: f64 = 0.8;
const PREVIEW_FPS: u32 = 8;
const SETTINGS_FILE: &str = "thumbnail-cache.json";

// Keep in sync with src/lib/mediaTypes.ts. `.ts` is left out on purpose: in a
// bucket it is far more often TypeScript or an HLS segment than a whole video.
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "ico",
];
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "webm", "m4v", "mpg", "mpeg", "m2ts", "wmv", "flv", "3gp",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Image,
    Video,
}

fn media_kind(key: &str) -> Option<MediaKind> {
    let name = key.rsplit('/').next().unwrap_or(key);
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Image)
    } else if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// An object to draw, as listed by the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct ThumbItem {
    pub key: String,
    pub last_modified: Option<String>,
    pub size: u64,
}

// ─── Cache ──────────────────────────────────────────────────────────────────

fn cache_root(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("thumbnails"))
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(SETTINGS_FILE))
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(data))
}

/// A path segment that cannot escape the cache directory.
fn safe_segment(value: &str) -> String {
    let plain = !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if plain {
        value.to_string()
    } else {
        sha256_hex(value.as_bytes())
    }
}

/// Cache path without extension. The object's modification date is part of the
/// hash, so an overwritten object gets a new thumbnail.
fn cache_base(root: &Path, profile_id: &str, bucket: &str, item: &ThumbItem) -> PathBuf {
    let mut id = item.key.clone().into_bytes();
    id.push(0);
    id.extend_from_slice(item.last_modified.as_deref().unwrap_or("").as_bytes());
    root.join(safe_segment(profile_id))
        .join(safe_segment(bucket))
        .join(sha256_hex(&id))
}

#[derive(Debug, Clone)]
struct CacheEntry {
    size: u64,
    accessed: SystemTime,
}

/// In-memory view of the cache directory, rebuilt from disk at first use.
#[derive(Debug, Default)]
struct CacheIndex {
    entries: HashMap<PathBuf, CacheEntry>,
    total: u64,
}

impl CacheIndex {
    fn insert(&mut self, path: PathBuf, size: u64, accessed: SystemTime) {
        if let Some(old) = self.entries.insert(path, CacheEntry { size, accessed }) {
            self.total -= old.size;
        }
        self.total += size;
    }

    fn remove(&mut self, path: &Path) {
        if let Some(old) = self.entries.remove(path) {
            self.total -= old.size;
        }
    }

    fn touch(&mut self, path: &Path, accessed: SystemTime) -> bool {
        match self.entries.get_mut(path) {
            Some(entry) => {
                entry.accessed = accessed;
                true
            }
            None => false,
        }
    }

    /// Drops least recently used entries until the total fits the limit and
    /// returns the files to delete.
    fn evict(&mut self, limit: u64) -> Vec<PathBuf> {
        if self.total <= limit {
            return Vec::new();
        }
        let mut by_age: Vec<(SystemTime, PathBuf)> = self
            .entries
            .iter()
            .map(|(path, entry)| (entry.accessed, path.clone()))
            .collect();
        by_age.sort();
        let mut victims = Vec::new();
        for (_, path) in by_age {
            if self.total <= limit {
                break;
            }
            self.remove(&path);
            victims.push(path);
        }
        victims
    }

    fn file_count(&self) -> usize {
        self.entries
            .keys()
            .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("jpg" | "webp")))
            .count()
    }

    fn scan(root: &Path) -> Self {
        let mut index = CacheIndex::default();
        for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("jpg" | "webp" | "fail" | "pfail") => {
                    if let Ok(meta) = entry.metadata() {
                        let accessed = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                        index.insert(path.to_path_buf(), meta.len(), accessed);
                    }
                }
                // Leftovers: interrupted writes and the old JSON manifest.
                _ => {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        index
    }
}

#[derive(Serialize, Deserialize)]
struct CacheSettings {
    limit_bytes: u64,
}

/// Disk cache shared by every generation. Last access is the file mtime, so
/// the index can always be rebuilt from the directory itself.
pub struct ThumbnailCache {
    index: tokio::sync::Mutex<Option<CacheIndex>>,
    limit: AtomicU64,
}

impl ThumbnailCache {
    fn new() -> Self {
        Self {
            index: tokio::sync::Mutex::new(None),
            limit: AtomicU64::new(DEFAULT_LIMIT_BYTES),
        }
    }

    async fn index(&self, app: &AppHandle) -> tokio::sync::MutexGuard<'_, Option<CacheIndex>> {
        let mut guard = self.index.lock().await;
        if guard.is_none() {
            if let Some(limit) = load_limit(app).await {
                self.limit.store(limit, Ordering::Relaxed);
            }
            let index = match cache_root(app) {
                Some(root) => tokio::task::spawn_blocking(move || CacheIndex::scan(&root))
                    .await
                    .unwrap_or_default(),
                None => CacheIndex::default(),
            };
            *guard = Some(index);
        }
        guard
    }

    /// Whether `path` is cached; a hit refreshes its last access.
    async fn hit(&self, app: &AppHandle, path: &Path) -> bool {
        let mut guard = self.index(app).await;
        let index = guard.get_or_insert_with(CacheIndex::default);
        let now = SystemTime::now();
        if !index.touch(path, now) {
            return false;
        }
        if touch_file(path, now).is_err() {
            // Deleted behind our back.
            index.remove(path);
            return false;
        }
        true
    }

    /// Whether a failure marker younger than [`FAILURE_RETRY`] exists.
    async fn recent_failure(&self, app: &AppHandle, marker: &Path) -> bool {
        let mut guard = self.index(app).await;
        let index = guard.get_or_insert_with(CacheIndex::default);
        let Some(entry) = index.entries.get(marker) else {
            return false;
        };
        let fresh = entry
            .accessed
            .elapsed()
            .map(|age| age < FAILURE_RETRY)
            .unwrap_or(true);
        if !fresh {
            index.remove(marker);
            let _ = std::fs::remove_file(marker);
        }
        fresh
    }

    /// Writes `bytes` atomically to `path`, records it and enforces the limit.
    /// Returns whether the file is in the cache afterwards.
    async fn store(&self, app: &AppHandle, path: &Path, bytes: &[u8]) -> bool {
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let mut part = path.as_os_str().to_owned();
        part.push(".part");
        let part = PathBuf::from(part);
        if tokio::fs::write(&part, bytes).await.is_err()
            || tokio::fs::rename(&part, path).await.is_err()
        {
            let _ = tokio::fs::remove_file(&part).await;
            return false;
        }
        self.register(app, path, bytes.len() as u64).await
    }

    /// Records a file already written at `path`.
    async fn register(&self, app: &AppHandle, path: &Path, size: u64) -> bool {
        let victims = {
            let mut guard = self.index(app).await;
            let index = guard.get_or_insert_with(CacheIndex::default);
            index.insert(path.to_path_buf(), size, SystemTime::now());
            index.evict(self.limit.load(Ordering::Relaxed))
        };
        let kept = !victims.iter().any(|v| v == path);
        remove_files(victims).await;
        kept
    }

    async fn info(&self, app: &AppHandle) -> CacheInfo {
        let guard = self.index(app).await;
        let (total, count) = guard
            .as_ref()
            .map(|i| (i.total, i.file_count()))
            .unwrap_or((0, 0));
        CacheInfo {
            total_size_bytes: total,
            limit_bytes: self.limit.load(Ordering::Relaxed),
            entry_count: count,
        }
    }

    async fn clear(&self, app: &AppHandle) -> Result<(), String> {
        let mut guard = self.index(app).await;
        if let Some(root) = cache_root(app) {
            match tokio::fs::remove_dir_all(&root).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        *guard = Some(CacheIndex::default());
        Ok(())
    }

    async fn set_limit(&self, app: &AppHandle, limit: u64) -> Result<(), String> {
        let victims = {
            let mut guard = self.index(app).await;
            self.limit.store(limit, Ordering::Relaxed);
            guard.get_or_insert_with(CacheIndex::default).evict(limit)
        };
        remove_files(victims).await;
        save_limit(app, limit).await
    }
}

fn touch_file(path: &Path, when: SystemTime) -> std::io::Result<()> {
    std::fs::File::options()
        .write(true)
        .open(path)?
        .set_modified(when)
}

async fn remove_files(paths: Vec<PathBuf>) {
    for path in paths {
        let _ = tokio::fs::remove_file(&path).await;
    }
}

async fn load_limit(app: &AppHandle) -> Option<u64> {
    let text = tokio::fs::read_to_string(settings_path(app)?).await.ok()?;
    serde_json::from_str::<CacheSettings>(&text)
        .ok()
        .map(|s| s.limit_bytes)
}

async fn save_limit(app: &AppHandle, limit_bytes: u64) -> Result<(), String> {
    let path = settings_path(app).ok_or("No config dir")?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&CacheSettings { limit_bytes }).map_err(|e| e.to_string())?;
    let part = path.with_extension("part");
    tokio::fs::write(&part, json)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&part, &path)
        .await
        .map_err(|e| e.to_string())
}

// ─── State ──────────────────────────────────────────────────────────────────

pub struct ThumbnailState {
    current: Mutex<Option<Generation>>,
    next_id: AtomicU64,
    cache: Arc<ThumbnailCache>,
}

impl Default for ThumbnailState {
    fn default() -> Self {
        Self::new()
    }
}

impl ThumbnailState {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
            next_id: AtomicU64::new(1),
            cache: Arc::new(ThumbnailCache::new()),
        }
    }

    fn cancel_current(&self) {
        if let Some(old) = self
            .current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            old.ctx.cancel.store(true, Ordering::Relaxed);
        }
    }

    fn context(
        &self,
        generation_id: u64,
    ) -> Option<(Arc<GenContext>, mpsc::UnboundedSender<ThumbItem>)> {
        let guard = self.current.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .filter(|g| g.ctx.id == generation_id)
            .map(|g| (g.ctx.clone(), g.tx.clone()))
    }
}

struct Generation {
    ctx: Arc<GenContext>,
    tx: mpsc::UnboundedSender<ThumbItem>,
}

#[derive(Debug, Clone, Copy)]
struct VideoInfo {
    duration: f64,
    hdr: bool,
}

struct GenContext {
    id: u64,
    app: AppHandle,
    client: aws_sdk_s3::Client,
    profile_id: String,
    bucket: String,
    root: PathBuf,
    cancel: AtomicBool,
    cache: Arc<ThumbnailCache>,
    video_slots: Semaphore,
    preview_slots: Semaphore,
    prefetch_slots: Semaphore,
    video_info: Mutex<HashMap<String, VideoInfo>>,
    /// Videos whose preview a task is building (or has built).
    previews_started: Mutex<HashSet<String>>,
}

/// Outcome of a generation attempt. Only `Unsupported` leaves a failure marker:
/// network errors and cancellations are retried next time.
enum Outcome {
    Done(Vec<u8>),
    Unsupported,
    Retry,
}

impl GenContext {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn base(&self, item: &ThumbItem) -> PathBuf {
        cache_base(&self.root, &self.profile_id, &self.bucket, item)
    }

    fn emit(&self, event: &str, key: &str, path: &Path) {
        if self.cancelled() {
            return;
        }
        let _ = self.app.emit(
            event,
            ThumbnailReady {
                generation_id: self.id,
                key: key.to_string(),
                path: path.to_string_lossy().into_owned(),
            },
        );
    }

    async fn presign(&self, key: &str) -> Option<String> {
        let config = aws_sdk_s3::presigning::PresigningConfig::expires_in(PRESIGN_TTL).ok()?;
        match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .presigned(config)
            .await
        {
            Ok(request) => Some(request.uri().to_string()),
            Err(e) => {
                log::debug!("thumbnail: presign failed for {key}: {e}");
                None
            }
        }
    }

    async fn video_info(&self, key: &str, url: &str) -> Option<VideoInfo> {
        if let Some(info) = self.lock_info().get(key).copied() {
            return Some(info);
        }
        let mut args = quiet_args("info");
        args.extend(net_input_args(url, None, None));
        let FfmpegRun::Done(output) = run_ffmpeg(self, args, PROBE_TIMEOUT).await else {
            return None;
        };
        let info = parse_video_info(&String::from_utf8_lossy(&output.stderr));
        self.lock_info().insert(key.to_string(), info);
        Some(info)
    }

    fn lock_started(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.previews_started
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn lock_info(&self) -> std::sync::MutexGuard<'_, HashMap<String, VideoInfo>> {
        self.video_info.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ─── Events ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ThumbnailReady {
    pub generation_id: u64,
    pub key: String,
    /// Absolute path of the cached file, for `convertFileSrc`.
    pub path: String,
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Starts a generation for one bucket and returns its id. Any previous
/// generation is cancelled. Objects are added with `enqueue_thumbnails`.
#[tauri::command]
pub async fn start_thumbnail_generation(
    bucket: String,
    bucket_region: Option<String>,
    app: AppHandle,
    profile_state: State<'_, ProfileState>,
    s3_state: State<'_, S3State>,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<u64, String> {
    thumb_state.cancel_current();

    let profile = {
        let pm = profile_state.read().await;
        pm.get_active_profile()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active profile".to_string())?
    };

    let client = {
        let mut s3 = s3_state.write().await;
        let region = bucket_region
            .filter(|r| !r.is_empty())
            .or_else(|| s3.get_bucket_region(&profile, &bucket));
        match region {
            Some(region) => s3.get_client_for_region(&profile, &region).await,
            None => s3.get_client(&profile).await,
        }
        .map_err(|e| e.to_string())?
        .clone()
    };

    let root = cache_root(&app).ok_or("No cache dir")?;
    let id = thumb_state.next_id.fetch_add(1, Ordering::Relaxed);
    let ctx = Arc::new(GenContext {
        id,
        app: app.clone(),
        client,
        profile_id: profile.id.clone(),
        bucket,
        root,
        cancel: AtomicBool::new(false),
        cache: thumb_state.cache.clone(),
        video_slots: Semaphore::new(VIDEO_CONCURRENCY),
        preview_slots: Semaphore::new(PREVIEW_CONCURRENCY),
        prefetch_slots: Semaphore::new(PREFETCH_CONCURRENCY),
        video_info: Mutex::new(HashMap::new()),
        previews_started: Mutex::new(HashSet::new()),
    });

    let (tx, rx) = mpsc::unbounded::<ThumbItem>();
    let worker = ctx.clone();
    tokio::spawn(async move {
        rx.for_each_concurrent(CONCURRENCY, |item| {
            let ctx = worker.clone();
            async move { process_item(&ctx, item).await }
        })
        .await;
    });

    // A newer generation may have started while this one was being set up.
    let mut guard = thumb_state
        .current
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(old) = guard.replace(Generation { ctx, tx }) {
        old.ctx.cancel.store(true, Ordering::Relaxed);
    }
    Ok(id)
}

/// Adds objects to a running generation. Unknown generations are ignored.
#[tauri::command]
pub async fn enqueue_thumbnails(
    generation_id: u64,
    items: Vec<ThumbItem>,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    if let Some((_, tx)) = thumb_state.context(generation_id) {
        for item in items {
            if tx.unbounded_send(item).is_err() {
                break;
            }
        }
    }
    Ok(())
}

/// Builds the animated hover preview of one video now, ahead of prefetching.
#[tauri::command]
pub async fn request_video_preview(
    generation_id: u64,
    item: ThumbItem,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    let Some((ctx, _)) = thumb_state.context(generation_id) else {
        return Ok(());
    };
    if media_kind(&item.key) != Some(MediaKind::Video) {
        return Ok(());
    }
    tokio::spawn(async move { process_preview(&ctx, item, false).await });
    Ok(())
}

/// Cancels the given generation, or the current one when no id is given.
#[tauri::command]
pub async fn cancel_thumbnail_generation(
    generation_id: Option<u64>,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    let mut guard = thumb_state
        .current
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let matches = guard
        .as_ref()
        .is_some_and(|g| generation_id.is_none_or(|id| g.ctx.id == id));
    if matches {
        if let Some(old) = guard.take() {
            old.ctx.cancel.store(true, Ordering::Relaxed);
        }
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
    Ok(thumb_state.cache.info(&app).await)
}

#[tauri::command]
pub async fn clear_thumbnail_cache(
    app: AppHandle,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    thumb_state.cancel_current();
    thumb_state.cache.clear(&app).await
}

#[tauri::command]
pub async fn set_cache_limit(
    limit_bytes: u64,
    app: AppHandle,
    thumb_state: State<'_, ThumbnailState>,
) -> Result<(), String> {
    thumb_state.cache.set_limit(&app, limit_bytes).await
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

async fn process_item(ctx: &Arc<GenContext>, item: ThumbItem) {
    if ctx.cancelled() {
        return;
    }
    let Some(kind) = media_kind(&item.key) else {
        return;
    };
    let base = ctx.base(&item);
    let poster = base.with_extension("jpg");

    if ctx.cache.hit(&ctx.app, &poster).await {
        ctx.emit("thumbnail_ready", &item.key, &poster);
        if kind == MediaKind::Video {
            let preview = base.with_extension("webp");
            if ctx.cache.hit(&ctx.app, &preview).await {
                ctx.emit("thumbnail_preview_ready", &item.key, &preview);
            } else {
                prefetch_preview(ctx, &item);
            }
        }
        return;
    }
    let marker = base.with_extension("fail");
    if ctx.cache.recent_failure(&ctx.app, &marker).await {
        return;
    }

    let outcome = match kind {
        MediaKind::Image => image_poster(ctx, &item).await,
        MediaKind::Video => video_poster(ctx, &item).await,
    };
    if ctx.cancelled() {
        return;
    }
    match outcome {
        Outcome::Done(bytes) => {
            if ctx.cache.store(&ctx.app, &poster, &bytes).await {
                ctx.emit("thumbnail_ready", &item.key, &poster);
                if kind == MediaKind::Video {
                    prefetch_preview(ctx, &item);
                }
            }
        }
        Outcome::Unsupported => {
            log::debug!("thumbnail: no thumbnail for {}", item.key);
            ctx.cache.store(&ctx.app, &marker, &[]).await;
        }
        Outcome::Retry => {}
    }
}

/// A content type that may hold an image. Many uploads carry a generic binary
/// type, so only explicit non-image types are refused.
fn may_be_image(content_type: Option<&str>) -> bool {
    let ct = content_type.unwrap_or("").trim().to_ascii_lowercase();
    ct.is_empty() || ct.starts_with("image/") || ct.contains("octet-stream")
}

async fn image_poster(ctx: &GenContext, item: &ThumbItem) -> Outcome {
    if item.size > MAX_IMAGE_BYTES {
        return Outcome::Retry;
    }
    let response = match ctx
        .client
        .get_object()
        .bucket(&ctx.bucket)
        .key(&item.key)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::debug!("thumbnail: GetObject failed for {}: {e}", item.key);
            return Outcome::Retry;
        }
    };
    if !may_be_image(response.content_type()) {
        return Outcome::Unsupported;
    }
    if response
        .content_length()
        .is_some_and(|len| len as u64 > MAX_IMAGE_BYTES)
    {
        return Outcome::Retry;
    }
    let bytes = match response.body.collect().await {
        Ok(b) => b.into_bytes(),
        Err(_) => return Outcome::Retry,
    };
    if ctx.cancelled() {
        return Outcome::Retry;
    }
    match tokio::task::spawn_blocking(move || render_image_thumbnail(&bytes)).await {
        Ok(Some(jpeg)) => Outcome::Done(jpeg),
        _ => Outcome::Unsupported,
    }
}

async fn video_poster(ctx: &GenContext, item: &ThumbItem) -> Outcome {
    let Ok(_slot) = ctx.video_slots.acquire().await else {
        return Outcome::Retry;
    };
    if ctx.cancelled() {
        return Outcome::Retry;
    }
    let Some(url) = ctx.presign(&item.key).await else {
        return Outcome::Retry;
    };
    let Some(info) = ctx.video_info(&item.key, &url).await else {
        return Outcome::Retry;
    };
    let mut hdr = info.hdr;
    loop {
        let args = poster_args(&url, info.duration, hdr);
        match run_ffmpeg(ctx, args, POSTER_TIMEOUT).await {
            FfmpegRun::Done(out) if out.status.success() && !out.stdout.is_empty() => {
                return Outcome::Done(out.stdout);
            }
            FfmpegRun::Done(_) if hdr => hdr = false, // retry without tone mapping
            FfmpegRun::Done(out) => {
                log::debug!(
                    "thumbnail: ffmpeg failed for {}: {}",
                    item.key,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
                return Outcome::Unsupported;
            }
            FfmpegRun::Aborted => return Outcome::Retry,
        }
    }
}

/// Builds (or finds) the animated preview and returns its path.
async fn build_preview(ctx: &GenContext, item: &ThumbItem) -> Option<PathBuf> {
    let base = ctx.base(item);
    let preview = base.with_extension("webp");
    if ctx.cache.hit(&ctx.app, &preview).await {
        return Some(preview);
    }
    let marker = base.with_extension("pfail");
    if ctx.cache.recent_failure(&ctx.app, &marker).await {
        return None;
    }
    let url = ctx.presign(&item.key).await?;
    let info = ctx.video_info(&item.key, &url).await?;
    if let Some(parent) = preview.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let part = base.with_extension("webp.part");
    let mut hdr = info.hdr;
    let succeeded = loop {
        let args = preview_args(&url, info.duration, hdr, &part);
        match run_ffmpeg(ctx, args, PREVIEW_TIMEOUT).await {
            FfmpegRun::Done(out) if out.status.success() => break Some(true),
            FfmpegRun::Done(_) if hdr => hdr = false,
            FfmpegRun::Done(out) => {
                log::debug!(
                    "thumbnail: preview failed for {}: {}",
                    item.key,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
                break Some(false);
            }
            FfmpegRun::Aborted => break None,
        }
    };
    let stored = match succeeded {
        Some(true) => match tokio::fs::metadata(&part).await {
            Ok(meta) if meta.len() > 0 && tokio::fs::rename(&part, &preview).await.is_ok() => {
                ctx.cache.register(&ctx.app, &preview, meta.len()).await
            }
            _ => false,
        },
        Some(false) => {
            ctx.cache.store(&ctx.app, &marker, &[]).await;
            false
        }
        None => false,
    };
    let _ = tokio::fs::remove_file(&part).await;
    stored.then_some(preview)
}

/// Builds the preview of a video on screen in the background, so that it is
/// usually ready before the user hovers it.
fn prefetch_preview(ctx: &Arc<GenContext>, item: &ThumbItem) {
    let ctx = ctx.clone();
    let item = item.clone();
    tokio::spawn(async move { process_preview(&ctx, item, true).await });
}

/// Emits `thumbnail_preview_ready`, or `thumbnail_preview_failed` so the
/// frontend can stop its loading indicator. Hover requests have their own
/// slots, so they never wait behind prefetching.
async fn process_preview(ctx: &GenContext, item: ThumbItem, prefetch: bool) {
    let preview = ctx.base(&item).with_extension("webp");
    if ctx.cache.hit(&ctx.app, &preview).await {
        ctx.emit("thumbnail_preview_ready", &item.key, &preview);
        return;
    }
    let slots = if prefetch {
        &ctx.prefetch_slots
    } else {
        &ctx.preview_slots
    };
    let Ok(_slot) = slots.acquire().await else {
        return;
    };
    if ctx.cancelled() {
        return;
    }
    // Another task is already building it and will emit the result.
    if !ctx.lock_started().insert(item.key.clone()) {
        return;
    }
    match build_preview(ctx, &item).await {
        Some(preview) => ctx.emit("thumbnail_preview_ready", &item.key, &preview),
        None => {
            // Allow a later hover to try again.
            ctx.lock_started().remove(&item.key);
            ctx.emit("thumbnail_preview_failed", &item.key, Path::new(""));
        }
    }
}

// ─── Image processing ───────────────────────────────────────────────────────

fn render_image_thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    use image::{DynamicImage, ImageDecoder, ImageReader};
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut thumb = shrink(DynamicImage::from_decoder(decoder).ok()?, THUMB_SIZE);
    thumb.apply_orientation(orientation);
    encode_jpeg(&flatten(&thumb))
}

/// Fits the image in `size`×`size` without enlarging it. A cheap pre-reduction
/// keeps Lanczos fast on large photos.
fn shrink(img: image::DynamicImage, size: u32) -> image::DynamicImage {
    use image::imageops::FilterType;
    if img.width() <= size && img.height() <= size {
        return img;
    }
    let img = if img.width() > size * 2 || img.height() > size * 2 {
        img.resize(size * 2, size * 2, FilterType::Triangle)
    } else {
        img
    };
    img.resize(size, size, FilterType::Lanczos3)
}

/// Composites transparent images over a light checkerboard, so transparency
/// stays visible once encoded as JPEG.
fn flatten(img: &image::DynamicImage) -> image::RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let p = rgba.get_pixel(x, y).0;
        let bg: u16 = if (x / 8 + y / 8) % 2 == 0 { 204 } else { 240 };
        let a = p[3] as u16;
        let mix = |c: u8| ((c as u16 * a + bg * (255 - a) + 127) / 255) as u8;
        image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])])
    })
}

fn encode_jpeg(rgb: &image::RgbImage) -> Option<Vec<u8>> {
    use image::codecs::jpeg::JpegEncoder;
    use image::ImageEncoder;
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
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

/// Duration and dynamic range from `ffmpeg -i` output. PQ (HDR10, Dolby
/// Vision) and HLG streams need tone mapping to look right in SDR.
fn parse_video_info(stderr: &str) -> VideoInfo {
    VideoInfo {
        duration: parse_duration_from_stderr(stderr)
            .filter(|d| *d > 0.0)
            .unwrap_or(2.0),
        hdr: stderr.lines().any(|l| {
            l.contains("Video:") && (l.contains("smpte2084") || l.contains("arib-std-b67"))
        }),
    }
}

fn quiet_args(loglevel: &str) -> Vec<String> {
    ["-nostdin", "-hide_banner", "-loglevel", loglevel]
        .map(String::from)
        .to_vec()
}

/// Input options for a presigned URL: bounded network waits, and only network
/// protocols, so that a crafted media file cannot make ffmpeg open local files.
fn net_input_args(url: &str, seek: Option<f64>, duration: Option<f64>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-rw_timeout",
        "15000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "2",
        "-protocol_whitelist",
        "https,tls,tcp,http,httpproxy",
    ]
    .map(String::from)
    .to_vec();
    if let Some(seek) = seek {
        args.extend(["-ss".to_string(), format!("{seek:.3}")]);
    }
    if let Some(duration) = duration {
        args.extend(["-t".to_string(), format!("{duration:.3}")]);
    }
    args.extend(["-i".to_string(), url.to_string()]);
    args
}

/// Common filter chain: deinterlace, square pixels, downscale with full chroma
/// precision, then tone map HDR to BT.709. Ends with a comma.
fn video_filter(box_px: u32, hdr: bool) -> String {
    let mut filter = format!(
        "bwdif=deint=interlaced,scale='trunc(iw*sar/2)*2':ih,setsar=1,\
         scale={box_px}:{box_px}:force_original_aspect_ratio=decrease:force_divisible_by=2:\
         flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,"
    );
    if hdr {
        filter.push_str(
            "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,\
             tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,",
        );
    }
    filter
}

/// One JPEG on stdout: the most representative frame of ~1 s around 40 %.
fn poster_args(url: &str, duration: f64, hdr: bool) -> Vec<String> {
    let mut args = quiet_args("error");
    args.extend(net_input_args(url, Some(duration * 0.4), None));
    args.extend(
        [
            "-an",
            "-sn",
            "-dn",
            "-frames:v",
            "1",
            "-vf",
            format!(
                "{}thumbnail=n=24,format=yuvj444p",
                video_filter(THUMB_SIZE, hdr)
            )
            .as_str(),
            "-c:v",
            "mjpeg",
            "-q:v",
            "3",
            "-f",
            "image2pipe",
            "pipe:1",
        ]
        .map(String::from),
    );
    args
}

/// Start times of the preview clips, spread over the video.
fn preview_segments(duration: f64) -> Vec<(f64, f64)> {
    if duration <= PREVIEW_SEGMENT_SECS {
        return vec![(0.0, duration.max(0.1))];
    }
    let count = PREVIEW_SEGMENTS
        .min((duration / PREVIEW_SEGMENT_SECS).floor() as usize)
        .max(1);
    (0..count)
        .map(|i| {
            let start = duration * (i as f64 + 0.5) / count as f64;
            let start = start.min(duration - PREVIEW_SEGMENT_SECS).max(0.0);
            (start, PREVIEW_SEGMENT_SECS)
        })
        .collect()
}

/// Animated WebP made of short real-motion clips, in a single ffmpeg run.
fn preview_args(url: &str, duration: f64, hdr: bool, output: &Path) -> Vec<String> {
    let segments = preview_segments(duration);
    let filter = video_filter(PREVIEW_SIZE, hdr);
    let mut args = quiet_args("error");
    let mut graph = String::new();
    let mut labels = String::new();
    for (i, (start, length)) in segments.iter().enumerate() {
        args.extend(net_input_args(url, Some(*start), Some(*length)));
        graph.push_str(&format!(
            "[{i}:v:0]fps={PREVIEW_FPS},{filter}setpts=PTS-STARTPTS[v{i}];"
        ));
        labels.push_str(&format!("[v{i}]"));
    }
    graph.push_str(&format!("{labels}concat=n={}:v=1:a=0[out]", segments.len()));
    args.extend(
        [
            "-filter_complex",
            graph.as_str(),
            "-map",
            "[out]",
            "-an",
            "-c:v",
            "libwebp_anim",
            "-quality",
            "72",
            "-compression_level",
            "4",
            "-loop",
            "0",
            "-y",
            "-f",
            "webp",
        ]
        .map(String::from),
    );
    args.push(output.to_string_lossy().into_owned());
    args
}

enum FfmpegRun {
    Done(std::process::Output),
    /// Missing sidecar, timeout or cancellation. The process is killed.
    Aborted,
}

async fn run_ffmpeg(ctx: &GenContext, args: Vec<String>, timeout: Duration) -> FfmpegRun {
    use tauri_plugin_shell::ShellExt;
    let Ok(sidecar) = ctx.app.shell().sidecar("brows3-ffmpeg") else {
        return FfmpegRun::Aborted;
    };
    let mut command: std::process::Command = sidecar.args(args).into();
    command.stdin(Stdio::null());
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);

    let run = tokio::time::timeout(timeout, command.output());
    let cancelled = async {
        while !ctx.cancelled() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    };
    tokio::select! {
        result = run => match result {
            Ok(Ok(output)) => FfmpegRun::Done(output),
            _ => FfmpegRun::Aborted,
        },
        _ = cancelled => FfmpegRun::Aborted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, last_modified: Option<&str>) -> ThumbItem {
        ThumbItem {
            key: key.into(),
            last_modified: last_modified.map(Into::into),
            size: 1,
        }
    }

    #[test]
    fn media_kind_uses_the_file_extension() {
        assert_eq!(media_kind("a/b/Photo.JPG"), Some(MediaKind::Image));
        assert_eq!(media_kind("clip.m2ts"), Some(MediaKind::Video));
        assert_eq!(media_kind("app.ts"), None);
        assert_eq!(media_kind("logo.svg"), None);
        assert_eq!(media_kind("folder.mp4/readme"), None);
        assert_eq!(media_kind("noext"), None);
    }

    #[test]
    fn cache_path_changes_when_the_object_changes() {
        let root = Path::new("/cache");
        let a = cache_base(root, "p", "b", &item("k.jpg", Some("2026-01-01")));
        let b = cache_base(root, "p", "b", &item("k.jpg", Some("2026-01-02")));
        assert_ne!(a, b);
        assert!(a.starts_with("/cache/p/b"));
    }

    #[test]
    fn cache_path_segments_cannot_escape_the_root() {
        let base = cache_base(Path::new("/cache"), "..", "a/b", &item("k", None));
        assert!(base.starts_with("/cache"));
        assert_eq!(base.components().count(), 5);
    }

    #[test]
    fn eviction_removes_least_recently_used_entries_first() {
        let t = |s| SystemTime::UNIX_EPOCH + Duration::from_secs(s);
        let mut index = CacheIndex::default();
        index.insert("old".into(), 40, t(1));
        index.insert("mid".into(), 40, t(2));
        index.insert("new".into(), 40, t(3));
        index.touch(Path::new("old"), t(4));
        assert_eq!(index.evict(80), vec![PathBuf::from("mid")]);
        assert_eq!(index.total, 80);
        assert!(index.evict(80).is_empty());
    }

    #[test]
    fn replacing_an_entry_keeps_the_total_exact() {
        let mut index = CacheIndex::default();
        index.insert("a".into(), 10, SystemTime::now());
        index.insert("a".into(), 30, SystemTime::now());
        assert_eq!(index.total, 30);
        index.remove(Path::new("a"));
        index.remove(Path::new("a"));
        assert_eq!(index.total, 0);
    }

    #[test]
    fn scan_rebuilds_the_index_and_drops_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("p/b");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("x.jpg"), [0u8; 10]).unwrap();
        std::fs::write(sub.join("x.webp"), [0u8; 5]).unwrap();
        std::fs::write(sub.join("y.fail"), []).unwrap();
        std::fs::write(sub.join("z.part"), [0u8; 3]).unwrap();
        std::fs::write(dir.path().join("manifest.json"), "{}").unwrap();
        let index = CacheIndex::scan(dir.path());
        assert_eq!(index.total, 15);
        assert_eq!(index.entries.len(), 3);
        assert_eq!(index.file_count(), 2);
        assert!(!sub.join("z.part").exists());
        assert!(!dir.path().join("manifest.json").exists());
    }

    #[test]
    fn generic_binary_content_types_may_be_images() {
        assert!(may_be_image(None));
        assert!(may_be_image(Some("image/png")));
        assert!(may_be_image(Some("application/octet-stream")));
        assert!(may_be_image(Some("binary/octet-stream")));
        assert!(!may_be_image(Some("text/html")));
        assert!(!may_be_image(Some("video/mp4")));
    }

    fn encode(img: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn transparent_pixels_are_not_black() {
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            50,
            50,
            image::Rgba([0, 0, 0, 0]),
        ));
        let jpeg = render_image_thumbnail(&encode(&img, image::ImageFormat::Png)).unwrap();
        let back = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert!(back.get_pixel(2, 2).0[0] > 180);
    }

    #[test]
    fn small_images_are_not_enlarged_and_large_ones_fit_the_box() {
        let small = image::DynamicImage::ImageRgb8(image::RgbImage::new(120, 80));
        assert_eq!(shrink(small, THUMB_SIZE).width(), 120);
        let large = image::DynamicImage::ImageRgb8(image::RgbImage::new(3000, 1000));
        let thumb = shrink(large, THUMB_SIZE);
        assert_eq!(thumb.width(), 400);
        assert!((133..=134).contains(&thumb.height()));
    }

    #[test]
    fn video_info_detects_duration_and_hdr() {
        let sdr = "  Duration: 00:01:02.50, start: 0.0\n    Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080";
        let info = parse_video_info(sdr);
        assert_eq!(info.duration, 62.5);
        assert!(!info.hdr);
        let pq = "  Duration: 00:00:12.00\n    Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160";
        assert!(parse_video_info(pq).hdr);
        let hlg = "    Stream #0:0: Video: hevc, yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67)";
        let info = parse_video_info(hlg);
        assert!(info.hdr);
        assert_eq!(info.duration, 2.0);
    }

    #[test]
    fn hdr_filter_tone_maps_and_sdr_filter_does_not() {
        assert!(video_filter(400, true).contains("tonemap=tonemap=hable"));
        let sdr = video_filter(400, false);
        assert!(!sdr.contains("tonemap"));
        assert!(sdr.contains("setsar=1"));
        assert!(sdr.ends_with(','));
    }

    #[test]
    fn preview_segments_stay_inside_the_video() {
        let segments = preview_segments(20.0);
        assert_eq!(segments.len(), PREVIEW_SEGMENTS);
        assert!(segments.iter().all(|(s, l)| *s >= 0.0 && s + l <= 20.0));
        assert_eq!(preview_segments(2.5).len(), 3);
        assert_eq!(preview_segments(0.4), vec![(0.0, 0.4)]);
    }

    #[test]
    fn preview_uses_one_input_per_segment() {
        let args = preview_args(
            "https://x/v.mp4",
            20.0,
            false,
            Path::new("/tmp/o.webp.part"),
        );
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), PREVIEW_SEGMENTS);
        let concat = format!("concat=n={PREVIEW_SEGMENTS}");
        assert!(args.iter().any(|a| a.contains(&concat)));
        assert_eq!(args.last().unwrap(), "/tmp/o.webp.part");
    }
}
