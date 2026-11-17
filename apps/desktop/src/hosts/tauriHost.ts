import { convertFileSrc, invoke, Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Host, ImageInfo, UploadProgress } from '../core/host.js';

/** Host backed by Rust commands in src-tauri/src/lib.rs (names must match `#[tauri::command]`s). */
export const tauriHost: Host = {
  kind: 'tauri',
  async pickFolder(title) {
    const r = await open({ directory: true, multiple: false, title });
    return typeof r === 'string' ? r : null;
  },
  scanImages: (folder) => invoke<ImageInfo[]>('scan_images', { folder }),
  fileUrl: (path) => convertFileSrc(path),
  makeThumb: (path, workspaceId) => invoke<ImageInfo>('make_thumb', { path, workspaceId }),
  readText: (rel) => invoke<string | null>('ws_read_text', { rel }),
  writeTextAtomic: (rel, text) => invoke<void>('ws_write_text', { rel, text }),
  listWorkspaces: () => invoke<string[]>('ws_list'),
  saveImage: (workspaceId, hash, bytes, mime) => invoke<string>('ws_save_image', { workspaceId, hash, mime, bytes: Array.from(bytes) }),
  uploadBlob(baseUrl, token, file, onProgress) {
    const ch = new Channel<UploadProgress>();
    ch.onmessage = onProgress;
    return invoke<void>('upload_blob', { baseUrl, token, path: file.path, hash: file.hash, mime: file.mime, onProgress: ch });
  },
  fetch: (url, init) => tauriFetch(url, init),
  getToken: (server) => invoke<string | null>('token_get', { server }),
  setToken: (server, token) => invoke<void>('token_set', { server, token }),
  deviceName: () => invoke<string>('device_name'),
  startSidecar: () => invoke<{ url: string; token: string } | null>('sidecar_start'),
};

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
