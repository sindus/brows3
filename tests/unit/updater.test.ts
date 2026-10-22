import { beforeEach, expect, test, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { updaterApi } from '@/lib/tauri';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true });
  vi.mocked(check).mockResolvedValue(null);
});

test('a Debian package install asks for its own manifest entry', async () => {
  vi.mocked(invoke).mockResolvedValueOnce('linux-x86_64-deb');
  await updaterApi.check();
  expect(invoke).toHaveBeenCalledWith('get_updater_target', expect.anything());
  expect(check).toHaveBeenCalledWith({ target: 'linux-x86_64-deb' });
});

test('other installs keep the updater default entry', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await updaterApi.check();
  expect(check).toHaveBeenCalledWith(undefined);
});

test('a failing target lookup still checks for updates with the default entry', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Command get_updater_target not found'));
  await updaterApi.check();
  expect(check).toHaveBeenCalledWith(undefined);
});
