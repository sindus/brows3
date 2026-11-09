// Files the grid can draw a thumbnail for.
// Keep in sync with IMAGE_EXTENSIONS / VIDEO_EXTENSIONS in
// src-tauri/src/commands/thumbnails.rs. `.ts` is left out on purpose: in a
// bucket it is far more often TypeScript or an HLS segment than a whole video.
import { getFileExtension } from './utils';

export const THUMBNAIL_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico',
]);

export const THUMBNAIL_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg', 'm2ts', 'wmv', 'flv', '3gp',
]);

export type ThumbnailKind = 'image' | 'video';

export function getThumbnailKind(key: string): ThumbnailKind | null {
  const ext = getFileExtension(key.split('/').pop() ?? key);
  if (THUMBNAIL_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (THUMBNAIL_VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}
