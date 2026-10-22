import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GridObjectView } from '@/components/common/GridObjectView';
import type { S3Object } from '@/lib/tauri';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const object = (key: string): S3Object => ({ key, size: 1, last_modified: '2026-01-01T00:00:00Z', storage_class: 'STANDARD' });
const baseProps = {
  folders: [],
  selectedKeys: new Set<string>(),
  isLoading: false,
  onNavigate: vi.fn(),
  onSelect: vi.fn(),
  onMenuOpen: vi.fn(),
};
const latestObserver = () => FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});
afterEach(() => vi.unstubAllGlobals());

test('asks for the next page when the end of the grid becomes visible', () => {
  const onEndReached = vi.fn();
  render(<GridObjectView {...baseProps} objects={[object('a.txt')]} onEndReached={onEndReached} />);
  expect(latestObserver().observe).toHaveBeenCalledTimes(1);
  latestObserver().trigger(false);
  expect(onEndReached).not.toHaveBeenCalled();
  latestObserver().trigger(true);
  expect(onEndReached).toHaveBeenCalledTimes(1);
});

test('observes the end of the grid again after more objects load', () => {
  const onEndReached = vi.fn();
  const view = render(<GridObjectView {...baseProps} objects={[object('a.txt')]} onEndReached={onEndReached} />);
  const first = latestObserver();
  view.rerender(<GridObjectView {...baseProps} objects={[object('a.txt'), object('b.txt')]} onEndReached={onEndReached} />);
  expect(first.disconnect).toHaveBeenCalledTimes(1);
  expect(FakeIntersectionObserver.instances).toHaveLength(2);
  expect(latestObserver().observe).toHaveBeenCalledTimes(1);
});

test('does not observe the grid when there is no next page', () => {
  render(<GridObjectView {...baseProps} objects={[object('a.txt')]} />);
  expect(FakeIntersectionObserver.instances).toHaveLength(0);
});

test('stops observing when the grid is removed', () => {
  const view = render(<GridObjectView {...baseProps} objects={[object('a.txt')]} onEndReached={vi.fn()} />);
  const observer = latestObserver();
  view.unmount();
  expect(observer.disconnect).toHaveBeenCalledTimes(1);
});
