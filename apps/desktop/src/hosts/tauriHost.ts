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
  allowFiles: (paths) => invoke<void>('allow_files', { paths }),
  makeThumb: (path, workspaceId) => invoke<ImageInfo>('make_thumb', { path, workspaceId }),
  readText: (rel) => invoke<string | null>('ws_read_text', { rel }),
  writeTextAtomic: (rel, text) => invoke<void>('ws_write_text', { rel, text }),
  listWorkspaces: () => invoke<string[]>('ws_list'),
  // raw binary bodies: no JSON number arrays for megabytes of PNG
  saveImage: (workspaceId, hash, bytes, mime) => invoke<string>('ws_save_image', bytes, { headers: { 'x-workspace': workspaceId, 'x-hash': hash, 'x-mime': mime } }),
  readFile: async (path) => new Uint8Array(await invoke<ArrayBuffer>('read_file', { path })),
  writeTemp: (workspaceId, name, bytes) => invoke<string>('ws_write_temp', bytes, { headers: { 'x-workspace': workspaceId, 'x-name': name } }),
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
