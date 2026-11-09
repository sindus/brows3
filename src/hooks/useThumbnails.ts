'use client';

import { useEffect, useMemo, useState } from 'react';
import { S3Object, thumbnailApi, ThumbnailItem, ThumbnailReadyPayload } from '@/lib/tauri';
import { getThumbnailKind } from '@/lib/mediaTypes';

type Urls = ReadonlyMap<string, string>;
type Flush = (thumbnails: Urls, previews: Urls, loadingPreviews: ReadonlySet<string>) => void;

const EMPTY: Urls = new Map();
const NONE: ReadonlySet<string> = new Set();
const FLUSH_DELAY_MS = 50;

const toItem = (object: S3Object): ThumbnailItem => ({
  key: object.key,
  last_modified: object.last_modified,
  size: object.size,
});

/**
 * Thumbnail requests of one folder view. The backend generation starts with
 * the first media object requested, objects are sent once, and incoming files
 * are delivered in batches. The session survives a dispose/activate cycle
 * (React StrictMode): everything requested is sent again to the new generation.
 */
export class ThumbnailSession {
  private generationId: number | null = null;
  private token: object | null = null;
  private active = false;
  private readonly requested = new Map<string, ThumbnailItem>();
  private pending: ThumbnailItem[] = [];
  private readonly previewsRequested = new Set<string>();
  /** Previews being built, for a loading indicator. */
  private readonly loadingPreviews = new Set<string>();
  private unlisteners: Array<() => void> = [];
  private batch = { thumbnails: new Map<string, string>(), previews: new Map<string, string>() };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly bucketName: string,
    private readonly bucketRegion: string | undefined,
    private readonly onFlush: Flush,
  ) {}

  /** Asks for the thumbnails of these objects; already requested ones are skipped. */
  readonly request = (objects: readonly S3Object[]) => {
    const fresh: ThumbnailItem[] = [];
    for (const object of objects) {
      if (this.requested.has(object.key) || !getThumbnailKind(object.key)) continue;
      const item = toItem(object);
      this.requested.set(object.key, item);
      fresh.push(item);
    }
    if (fresh.length === 0) return;
    if (this.generationId !== null) {
      thumbnailApi.enqueue(this.generationId, fresh).catch(() => {});
    } else {
      this.pending.push(...fresh);
      this.start();
    }
  };

  /** Asks for the animated hover preview of a video. */
  readonly requestPreview = (object: S3Object) => {
    if (this.generationId === null || getThumbnailKind(object.key) !== 'video') return;
    if (this.previewsRequested.has(object.key)) return;
    this.previewsRequested.add(object.key);
    this.setLoading(object.key, true);
    thumbnailApi.requestPreview(this.generationId, toItem(object)).catch(() => {
      this.previewsRequested.delete(object.key);
      this.setLoading(object.key, false);
    });
  };

  activate() {
    this.active = true;
    if (this.pending.length > 0) this.start();
  }

  dispose() {
    this.active = false;
    this.token = null;
    if (this.generationId !== null) thumbnailApi.cancelGeneration(this.generationId).catch(() => {});
    this.generationId = null;
    this.unlisteners.forEach((unlisten) => unlisten());
    this.unlisteners = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.previewsRequested.clear();
    this.loadingPreviews.clear();
    this.pending = [...this.requested.values()];
  }

  private start() {
    if (!this.active || this.token) return;
    const token = {};
    this.token = token;
    this.run(token).catch(() => {
      if (this.token === token) this.token = null;
    });
  }

  private async run(token: object) {
    const [{ listen }, { convertFileSrc }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/core'),
    ]);
    const handler = (target: 'thumbnails' | 'previews') => (event: { payload: ThumbnailReadyPayload }) => {
      const { generation_id, key, path } = event.payload;
      if (this.token !== token || generation_id !== this.generationId) return;
      this.batch[target].set(key, convertFileSrc(path));
      if (target === 'previews') this.loadingPreviews.delete(key);
      this.schedule();
    };
    const onPreviewFailed = (event: { payload: ThumbnailReadyPayload }) => {
      if (this.token !== token || event.payload.generation_id !== this.generationId) return;
      // A later hover may try again.
      this.previewsRequested.delete(event.payload.key);
      this.setLoading(event.payload.key, false);
    };
    const unlisteners = [
      await listen<ThumbnailReadyPayload>('thumbnail_ready', handler('thumbnails')),
      await listen<ThumbnailReadyPayload>('thumbnail_preview_ready', handler('previews')),
      await listen<ThumbnailReadyPayload>('thumbnail_preview_failed', onPreviewFailed),
    ];
    if (this.token !== token) {
      unlisteners.forEach((unlisten) => unlisten());
      return;
    }
    this.unlisteners.push(...unlisteners);

    const generationId = await thumbnailApi.startGeneration(this.bucketName, this.bucketRegion);
    if (this.token !== token) {
      thumbnailApi.cancelGeneration(generationId).catch(() => {});
      return;
    }
    this.generationId = generationId;
    const pending = this.pending;
    this.pending = [];
    if (pending.length > 0) thumbnailApi.enqueue(generationId, pending).catch(() => {});
  }

  private setLoading(key: string, loading: boolean) {
    if (loading) this.loadingPreviews.add(key);
    else this.loadingPreviews.delete(key);
    this.schedule();
  }

  private schedule() {
    this.timer ??= setTimeout(this.flush, FLUSH_DELAY_MS);
  }

  private readonly flush = () => {
    this.timer = null;
    const { thumbnails, previews } = this.batch;
    this.batch = { thumbnails: new Map(), previews: new Map() };
    this.onFlush(thumbnails, previews, new Set(this.loadingPreviews));
  };
}

interface UrlState {
  scope: string;
  thumbnails: Urls;
  previews: Urls;
  loadingPreviews: ReadonlySet<string>;
}

const merge = (base: Urls, added: Urls): Urls => (added.size === 0 ? base : new Map([...base, ...added]));

/**
 * Thumbnails of a folder view, as asset URLs:
 * - thumbnails: static JPEG for images and videos;
 * - previews: animated WebP of videos, built on demand with `requestPreview`;
 * - loadingPreviews: videos whose preview is being built.
 * Call `requestThumbnails` with the objects that become visible.
 */
export function useThumbnails(bucketName: string, bucketRegion: string | undefined, scopeKey: string) {
  const scope = `${bucketName}\n${bucketRegion ?? ''}\n${scopeKey}`;
  const [urls, setUrls] = useState<UrlState>({ scope: '', thumbnails: EMPTY, previews: EMPTY, loadingPreviews: NONE });

  const session = useMemo(
    () => new ThumbnailSession(bucketName, bucketRegion, (thumbnails, previews, loadingPreviews) => {
      setUrls((prev) => {
        const base = prev.scope === scope ? prev : { scope, thumbnails: EMPTY, previews: EMPTY };
        return {
          scope,
          thumbnails: merge(base.thumbnails, thumbnails),
          previews: merge(base.previews, previews),
          loadingPreviews,
        };
      });
    }),
    [bucketName, bucketRegion, scope],
  );

  useEffect(() => {
    session.activate();
    return () => session.dispose();
  }, [session]);

  const current = urls.scope === scope ? urls : null;
  return {
    thumbnails: current?.thumbnails ?? EMPTY,
    previews: current?.previews ?? EMPTY,
    loadingPreviews: current?.loadingPreviews ?? NONE,
    requestThumbnails: session.request,
    requestPreview: session.requestPreview,
  };
}
