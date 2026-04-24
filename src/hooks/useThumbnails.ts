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
  data: string; // base64 JPEG
}

/**
 * Triggers async thumbnail generation for image objects in a bucket.
 * Returns a Map<key, dataUrl> that grows as thumbnails become available.
 * Cancels automatically when bucket/prefix changes or component unmounts.
 */
export function useThumbnails(
  bucketName: string,
  bucketRegion: string,
  objects: S3Object[],
  enabled: boolean,
): Map<string, string> {
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  // track which bucket+prefix generation is active so stale events are ignored
  const sessionRef = useRef<string>('');

  useEffect(() => {
    if (!enabled || !bucketName) return;

    const imageKeys = objects.map(o => o.key).filter(shouldAttemptThumbnail);
    if (imageKeys.length === 0) return;

    // New session id — stale thumbnail_ready events from previous sessions are dropped
    const session = `${bucketName}:${bucketRegion}:${Date.now()}`;
    sessionRef.current = session;

    // Reset thumbnails for this bucket/prefix
    setThumbnails(new Map());

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    async function start() {
      // Listen for thumbnail_ready events BEFORE starting generation
      // so we don't miss events emitted very quickly
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<ThumbnailReadyPayload>('thumbnail_ready', (event) => {
        // Drop events from a previous session (bucket changed mid-flight)
        if (sessionRef.current !== session) return;
        const { key, data } = event.payload;
        setThumbnails(prev => {
          const next = new Map(prev);
          next.set(key, `data:image/jpeg;base64,${data}`);
          return next;
        });
      });

      if (cancelled) {
        unlisten();
        return;
      }

      try {
        await thumbnailApi.startGeneration(bucketName, bucketRegion, imageKeys);
      } catch {
        // Non-fatal: generation fails silently, grid still shows icons
      }
    }

    start();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      // Cancel the Rust-side generation
      thumbnailApi.cancelGeneration().catch(() => {});
    };
  // Re-run only when bucket, region or the set of objects changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketName, bucketRegion, enabled, objects]);

  return thumbnails;
}
