import { readImageHeader, sha256Hex } from '@komaflow/contract';
import type { Host, ImageInfo } from '../src/core/host.js';

/** In-memory host for tests: files live in a map, HTTP goes to the given fetch (e.g. app.inject). */
export class MemoryHost implements Host {
  kind = 'memory' as const;
  files = new Map<string, Uint8Array>();
  texts = new Map<string, string>();
  tokens = new Map<string, string | null>();
  uploads: string[] = [];
  failUploads = 0;

  constructor(readonly doFetch: (url: string, init: RequestInit) => Promise<Response>) {}

  addFolder(folder: string, files: Record<string, Uint8Array>) {
    for (const [name, bytes] of Object.entries(files)) this.files.set(`${folder}/${name}`, bytes);
  }

  info(path: string): ImageInfo {
    const bytes = this.files.get(path)!;
    const h = readImageHeader(bytes)!;
    return { path, name: path.split('/').pop()!, hash: sha256Hex(bytes), width: h.width, height: h.height, mime: h.mime, size: bytes.length };
  }

  pickFolder = async () => null;
  scanImages = async (folder: string) => [...this.files.keys()].filter((p) => p.startsWith(`${folder}/`) && /\.(png|jpe?g|webp)$/i.test(p)).map((p) => this.info(p));
  fileUrl = (p: string) => `mem://${p}`;
  allowFiles = async () => {};
  makeThumb = async (path: string, ws: string) => {
    // A "thumbnail" that is just a copy is enough for the contract (any image type, any size).
    const bytes = this.files.get(path)!;
    const p = `ws/${ws}/thumbs/${sha256Hex(bytes)}.png`;
    this.files.set(p, bytes);
    return this.info(p);
  };
  readText = async (rel: string) => this.texts.get(rel) ?? null;
  writeTextAtomic = async (rel: string, text: string) => void this.texts.set(rel, text);
  listWorkspaces = async () => [...new Set([...this.texts.keys()].map((k) => k.split('/')[0]!))];
  saveImage = async (ws: string, hash: string, bytes: Uint8Array) => {
    const p = `ws/${ws}/images/${hash}`;
    this.files.set(p, bytes);
    return p;
  };
  readFile = async (path: string) => {
    const b = this.files.get(path);
    if (!b) throw new Error(`no file ${path}`);
    return b;
  };
  writeTemp = async (ws: string, name: string, bytes: Uint8Array) => {
    const p = `ws/${ws}/tmp/${name}`;
    this.files.set(p, bytes);
    return p;
  };
  uploadBlob = async (base: string, token: string, f: { path: string; hash: string; mime: string }) => {
    if (this.failUploads > 0) {
      this.failUploads--;
      throw new Error('connection reset');
    }
    const res = await this.doFetch(`${base}/api/v1/blobs/${f.hash}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': f.mime },
      body: this.files.get(f.path) as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
    this.uploads.push(f.hash);
  };
  fetch = (url: string, init: RequestInit) => this.doFetch(url, init);
  getToken = async (s: string) => this.tokens.get(s) ?? null;
  setToken = async (s: string, t: string | null) => void this.tokens.set(s, t);
  deviceName = async () => 'test-pc';
  startSidecar = async () => null;
}
