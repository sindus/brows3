'use client';

import { useState, useEffect, useRef } from 'react';
import { S3Object, thumbnailApi } from '@/lib/tauri';

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico',
]);

// Extensions we're certain are NOT visual — skip them without downloading
const NON_VISUAL_EXTENSIONS = new Set([
  // Audio only
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Code
  'js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'h', 'rb', 'php',
  // Text
  'txt', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'log', 'html', 'css', 'sh',
  // Binaries / fonts
  'exe', 'dll', 'so', 'dylib', 'ttf', 'woff', 'woff2', 'eot',
]);

function shouldAttemptThumbnail(key: string): boolean {
  const filename = key.split('/').pop() ?? '';
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return true; // no extension → could be an image, let Rust decide via content-type
  const ext = filename.slice(dot + 1).toLowerCase();
  if (NON_VISUAL_EXTENSIONS.has(ext)) return false;
  // Includes: known image exts, known video exts, unknown exts
  return true;
}

interface ThumbnailReadyPayload {
  key: string;
  data: string;
}

/**
 * Triggers async thumbnail generation for visual objects in a bucket.
 * Returns { thumbnails, previews } maps that grow as assets become available.
 * - thumbnails: static JPEG for images and videos (shown by default)
 * - previews: animated WebP for videos (shown on hover)
 * Cancels automatically when bucket/prefix changes or component unmounts.
 */
export function useThumbnails(
  bucketName: string,
  bucketRegion: string,
  objects: S3Object[],
  enabled: boolean,
): { thumbnails: Map<string, string>; previews: Map<string, string> } {
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const sessionRef = useRef<string>('');

  useEffect(() => {
    if (!enabled || !bucketName) return;

    const keys = objects.map(o => o.key).filter(shouldAttemptThumbnail);
    if (keys.length === 0) return;

    const session = `${bucketName}:${bucketRegion}:${Date.now()}`;
    sessionRef.current = session;

    setThumbnails(new Map());
    setPreviews(new Map());

    let unlistenJpeg: (() => void) | null = null;
    let unlistenPreview: (() => void) | null = null;
    let cancelled = false;

    async function start() {
      const { listen } = await import('@tauri-apps/api/event');

      unlistenJpeg = await listen<ThumbnailReadyPayload>('thumbnail_ready', (event) => {
        if (sessionRef.current !== session) return;
        const { key, data } = event.payload;
        setThumbnails(prev => { const next = new Map(prev); next.set(key, `data:image/jpeg;base64,${data}`); return next; });
      });

      unlistenPreview = await listen<ThumbnailReadyPayload>('thumbnail_preview_ready', (event) => {
        if (sessionRef.current !== session) return;
        const { key, data } = event.payload;
        setPreviews(prev => { const next = new Map(prev); next.set(key, `data:image/webp;base64,${data}`); return next; });
      });

      if (cancelled) {
        unlistenJpeg?.();
        unlistenPreview?.();
        return;
      }

      try {
        await thumbnailApi.startGeneration(bucketName, bucketRegion, keys);
      } catch {
        // Non-fatal
      }
    }

    start();

    return () => {
      cancelled = true;
      unlistenJpeg?.();
      unlistenPreview?.();
      thumbnailApi.cancelGeneration().catch(() => {});
    };

  }, [bucketName, bucketRegion, enabled, objects]);

  return { thumbnails, previews };
}
