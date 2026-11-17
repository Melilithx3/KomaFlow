/**
 * Everything that touches the OS goes through the host (docs/05 §3: files, hashes, uploads and the token
 * live on the Rust side). `tauriHost` implements it with Tauri commands; tests use an in-memory host;
 * `browserHost` lets the UI run in a plain browser against a dev server.
 */
export interface ImageInfo {
  path: string;
  name: string;
  hash: string;
  width: number;
  height: number;
  mime: string;
  size: number;
}

export interface UploadProgress {
  hash: string;
  sent: number;
  total: number;
}

export interface Host {
  kind: 'tauri' | 'browser' | 'memory';
  /** Lets the user pick a folder; null when cancelled. */
  pickFolder(title: string): Promise<string | null>;
  /** Lists PNG/JPEG/WebP files of a folder with streaming SHA-256 and header size. */
  scanImages(folder: string): Promise<ImageInfo[]>;
  /** URL the WebView can show for a local file. */
  fileUrl(path: string): string;
  /** WebP thumbnail ~400 px wide; returns its file info (stored in the workspace thumbs/). */
  makeThumb(path: string, workspaceId: string): Promise<ImageInfo>;

  /** Workspace storage under %LOCALAPPDATA%/komaflow/workspaces/<id>/ (atomic writes). */
  readText(rel: string): Promise<string | null>;
  writeTextAtomic(rel: string, text: string): Promise<void>;
  listWorkspaces(): Promise<string[]>;
  /** Saves downloaded bytes into the workspace images/ cache; returns the path. */
  saveImage(workspaceId: string, hash: string, bytes: Uint8Array, mime: string): Promise<string>;

  /** Streams a local file to PUT /blobs/{hash} with progress. */
  uploadBlob(baseUrl: string, token: string, file: { path: string; hash: string; mime: string }, onProgress: (p: UploadProgress) => void): Promise<void>;
  /** JSON / bytes HTTP without CORS (Tauri HTTP plugin). */
  fetch(url: string, init: RequestInit): Promise<Response>;

  getToken(server: string): Promise<string | null>;
  setToken(server: string, token: string | null): Promise<void>;
  deviceName(): Promise<string>;

  /** Starts the Python sidecar (if installed): returns its base URL and one-time token, or null. */
  startSidecar(): Promise<{ url: string; token: string } | null>;
}
