import { readImageHeader, sha256Hex } from '@komaflow/contract';
import type { Host, ImageInfo } from '../core/host.js';

/**
 * Development host: runs the desktop UI in a normal browser (`pnpm --filter @komaflow/desktop dev`)
 * against a dev server through the Vite proxy. Files picked with a directory input live in memory
 * (object URLs), workspaces in localStorage. Not used in the packaged app.
 */
const files = new Map<string, { bytes: Uint8Array; url: string; info: ImageInfo }>();
const folders = new Map<string, string[]>();
let folderSeq = 0;

function register(path: string, bytes: Uint8Array): ImageInfo {
  const h = readImageHeader(bytes);
  if (!h) throw new Error(`${path}: not an image`);
  const info: ImageInfo = { path, name: path.split('/').pop()!, hash: sha256Hex(bytes), width: h.width, height: h.height, mime: h.mime, size: bytes.length };
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: h.mime }));
  files.set(path, { bytes, url, info });
  return info;
}

const LS = 'komaflow-desktop:';

export const browserHost: Host = {
  kind: 'browser',
  pickFolder(title) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.setAttribute('webkitdirectory', '');
      input.title = title;
      input.onchange = async () => {
        const list = [...(input.files ?? [])].filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
        const id = `folder${++folderSeq}`;
        const paths: string[] = [];
        for (const f of list) {
          const p = `${id}/${f.name}`;
          register(p, new Uint8Array(await f.arrayBuffer()));
          paths.push(p);
        }
        folders.set(id, paths);
        resolve(id);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
  scanImages: async (folder) => (folders.get(folder) ?? []).map((p) => files.get(p)!.info),
  fileUrl: (path) => files.get(path)?.url ?? '',
  allowFiles: async () => {},
  async makeThumb(path) {
    const f = files.get(path)!;
    const bmp = await createImageBitmap(new Blob([f.bytes as BlobPart], { type: f.info.mime }));
    const w = Math.min(400, bmp.width);
    const h = Math.round((bmp.height * w) / bmp.width);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return register(`thumbs/${f.info.hash}.webp`, new Uint8Array(await blob.arrayBuffer()));
  },
  readText: async (rel) => localStorage.getItem(LS + rel),
  writeTextAtomic: async (rel, text) => localStorage.setItem(LS + rel, text),
  listWorkspaces: async () => {
    const ids = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(LS) && k.endsWith('/workspace.json')) ids.add(k.slice(LS.length).split('/')[0]!);
    }
    return [...ids];
  },
  saveImage: async (ws, hash, bytes) => {
    const p = `${ws}/images/${hash}`;
    if (!files.has(p)) register(p, bytes);
    return p;
  },
  async readFile(path) {
    const f = files.get(path);
    if (!f) throw new Error(`no file ${path}`);
    return f.bytes;
  },
  async writeTemp(ws, name, bytes) {
    const p = `${ws}/tmp/${name}`;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    files.set(p, { bytes, url, info: { path: p, name, hash: '', width: 0, height: 0, mime: 'application/octet-stream', size: bytes.length } });
    return p;
  },
  async uploadBlob(baseUrl, token, file) {
    const res = await fetch(`${baseUrl}/api/v1/blobs/${file.hash}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.mime },
      body: files.get(file.path)!.bytes as BodyInit,
    });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
  },
  fetch: (url, init) => fetch(url, init),
  getToken: async (s) => localStorage.getItem(`${LS}token:${s}`),
  setToken: async (s, t) => (t ? localStorage.setItem(`${LS}token:${s}`, t) : localStorage.removeItem(`${LS}token:${s}`)),
  deviceName: async () => 'Браузер (dev)',
  startSidecar: async () => null,
};
