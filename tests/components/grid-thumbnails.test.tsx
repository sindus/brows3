import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VirtuosoGridMockContext } from 'react-virtuoso';
import { GridObjectView } from '@/components/common/GridObjectView';
import { thumbnailApi, type S3Object, type ThumbnailReadyPayload } from '@/lib/tauri';

type Listener = (event: { payload: ThumbnailReadyPayload }) => void;
const listeners = new Map<string, Listener>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Listener) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset://localhost${path}` }));

class Noop { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); }

const object = (key: string): S3Object => ({ key, size: 10, last_modified: '2026-01-01T00:00:00Z', storage_class: 'STANDARD' });
const props = {
  folders: ['docs/'],
  selectedKeys: new Set<string>(),
  isLoading: false,
  onNavigate: vi.fn(),
  onSelect: vi.fn(),
  onMenuOpen: vi.fn(),
  bucketName: 'demo-bucket',
  bucketRegion: 'eu-west-3',
  scopeKey: 'view-1',
};

const renderGrid = (objects: S3Object[], extra: Partial<typeof props> & { onPreview?: (key: string, size: number) => void } = {}) =>
  render(
    <VirtuosoGridMockContext.Provider value={{ viewportHeight: 800, viewportWidth: 800, itemHeight: 150, itemWidth: 140 }}>
      <GridObjectView {...props} {...extra} objects={objects} />
    </VirtuosoGridMockContext.Provider>,
  );

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

beforeEach(() => {
  listeners.clear();
  vi.stubGlobal('IntersectionObserver', Noop);
  vi.stubGlobal('ResizeObserver', Noop);
  vi.spyOn(thumbnailApi, 'startGeneration').mockResolvedValue(7);
  vi.spyOn(thumbnailApi, 'enqueue').mockResolvedValue();
  vi.spyOn(thumbnailApi, 'cancelGeneration').mockResolvedValue();
  vi.spyOn(thumbnailApi, 'requestPreview').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('only media objects are requested, once, with their modification date', async () => {
  const view = renderGrid([object('a.jpg'), object('notes.txt'), object('clip.mp4')]);
  await flush();
  expect(thumbnailApi.startGeneration).toHaveBeenCalledWith('demo-bucket', 'eu-west-3');
  expect(thumbnailApi.enqueue).toHaveBeenCalledTimes(1);
  expect(vi.mocked(thumbnailApi.enqueue).mock.calls[0]).toEqual([7, [
    { key: 'a.jpg', last_modified: '2026-01-01T00:00:00Z', size: 10 },
    { key: 'clip.mp4', last_modified: '2026-01-01T00:00:00Z', size: 10 },
  ]]);

  // A next page only sends the new objects.
  view.rerender(
    <VirtuosoGridMockContext.Provider value={{ viewportHeight: 800, viewportWidth: 800, itemHeight: 150, itemWidth: 140 }}>
      <GridObjectView {...props} objects={[object('a.jpg'), object('notes.txt'), object('clip.mp4'), object('b.png')]} />
    </VirtuosoGridMockContext.Provider>,
  );
  await flush();
  expect(thumbnailApi.startGeneration).toHaveBeenCalledTimes(1);
  expect(vi.mocked(thumbnailApi.enqueue).mock.calls.at(-1)?.[1]).toEqual([{ key: 'b.png', last_modified: '2026-01-01T00:00:00Z', size: 10 }]);
});

test('a folder without media starts no generation', async () => {
  renderGrid([object('notes.txt')]);
  await flush();
  expect(thumbnailApi.startGeneration).not.toHaveBeenCalled();
});

test('thumbnails of the current generation are shown, stale ones ignored', async () => {
  renderGrid([object('a.jpg')]);
  await flush();
  act(() => {
    listeners.get('thumbnail_ready')?.({ payload: { generation_id: 3, key: 'a.jpg', path: '/old/a.jpg' } });
    listeners.get('thumbnail_ready')?.({ payload: { generation_id: 7, key: 'a.jpg', path: '/cache/a.jpg' } });
  });
  await flush();
  expect(screen.getByRole('img', { name: 'a.jpg' }).getAttribute('src')).toBe('asset://localhost/cache/a.jpg');
});

test('hovering a video asks for its animated preview and shows it', async () => {
  renderGrid([object('clip.mp4')]);
  await flush();
  act(() => listeners.get('thumbnail_ready')?.({ payload: { generation_id: 7, key: 'clip.mp4', path: '/cache/clip.jpg' } }));
  await flush();
  fireEvent.mouseEnter(screen.getByRole('group', { name: 'clip.mp4' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  expect(thumbnailApi.requestPreview).toHaveBeenCalledWith(7, { key: 'clip.mp4', last_modified: '2026-01-01T00:00:00Z', size: 10 });
  await flush();
  expect(screen.getByRole('progressbar', { name: 'Loading preview of clip.mp4' })).toBeTruthy();
  act(() => listeners.get('thumbnail_preview_ready')?.({ payload: { generation_id: 7, key: 'clip.mp4', path: '/cache/clip.webp' } }));
  await flush();
  expect(screen.getByRole('img', { name: 'clip.mp4' }).getAttribute('src')).toBe('asset://localhost/cache/clip.webp');
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('the loading indicator stops when a preview cannot be built', async () => {
  renderGrid([object('clip.mp4')]);
  await flush();
  act(() => listeners.get('thumbnail_ready')?.({ payload: { generation_id: 7, key: 'clip.mp4', path: '/cache/clip.jpg' } }));
  await flush();
  fireEvent.mouseEnter(screen.getByRole('group', { name: 'clip.mp4' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await flush();
  expect(screen.getByRole('progressbar')).toBeTruthy();
  act(() => listeners.get('thumbnail_preview_failed')?.({ payload: { generation_id: 7, key: 'clip.mp4', path: '' } }));
  await flush();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('the generation is cancelled when the view goes away', async () => {
  const view = renderGrid([object('a.jpg')]);
  await flush();
  view.unmount();
  expect(thumbnailApi.cancelGeneration).toHaveBeenCalledWith(7);
});

test('cards open with Enter and toggle selection with Space', async () => {
  const onPreview = vi.fn();
  renderGrid([object('a.jpg')], { onPreview });
  const card = screen.getByRole('group', { name: 'a.jpg' });
  fireEvent.keyDown(card, { key: 'Enter' });
  expect(onPreview).toHaveBeenCalledWith('a.jpg', 10);
  fireEvent.keyDown(card, { key: ' ' });
  expect(props.onSelect).toHaveBeenCalledWith('a.jpg', true);
  fireEvent.keyDown(screen.getByRole('group', { name: 'docs' }), { key: 'Enter' });
  expect(props.onNavigate).toHaveBeenCalledWith('docs/');
});
