//! Rust side of the komaflow desktop (docs/05 §3): folders, streaming SHA-256, image headers,
//! thumbnails, atomic workspace files, streaming blob uploads with progress, the token in the
//! Windows Credential Manager and the Python sidecar process. Names of the commands must match
//! `src/hosts/tauriHost.ts`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{Manager, State};

const IMAGE_EXT: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
const KEYRING_SERVICE: &str = "komaflow";

#[derive(Serialize, Clone)]
pub struct ImageInfo {
    path: String,
    name: String,
    hash: String,
    width: u32,
    height: u32,
    mime: String,
    size: u64,
}

#[derive(Serialize, Clone)]
pub struct UploadProgress {
    hash: String,
    sent: u64,
    total: u64,
}

#[derive(Serialize)]
pub struct SidecarInfo {
    url: String,
    token: String,
}

#[derive(Default)]
struct SidecarState(Mutex<Option<std::process::Child>>);

type CmdResult<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ------------------------------------------------------------------ paths

fn app_root() -> CmdResult<PathBuf> {
    let base = dirs::data_local_dir().ok_or("no %LOCALAPPDATA%")?;
    Ok(base.join("komaflow"))
}

fn workspaces_dir() -> CmdResult<PathBuf> {
    Ok(app_root()?.join("workspaces"))
}

/// Resolves a path relative to the workspaces dir and refuses to leave it.
fn ws_path(rel: &str) -> CmdResult<PathBuf> {
    if rel.contains("..") || Path::new(rel).is_absolute() {
        return Err(format!("bad workspace path: {rel}"));
    }
    Ok(workspaces_dir()?.join(rel))
}

fn mime_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Streaming SHA-256 (1 MiB buffer) + header size; never decodes pixels.
fn image_info(path: &Path) -> CmdResult<ImageInfo> {
    let mime = mime_of(path).ok_or_else(|| format!("{}: unsupported type", path.display()))?;
    let mut f = std::fs::File::open(path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    let dim = imagesize::size(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(ImageInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        hash: hex::encode(hasher.finalize()),
        width: dim.width as u32,
        height: dim.height as u32,
        mime: mime.to_string(),
        size,
    })
}

fn allow_dir(app: &tauri::AppHandle, dir: &Path) {
    // Lets the WebView show files of this folder through the asset protocol (scope starts empty).
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

// ------------------------------------------------------------------ commands: files

#[tauri::command]
async fn scan_images(app: tauri::AppHandle, folder: String) -> CmdResult<Vec<ImageInfo>> {
    let dir = PathBuf::from(&folder);
    allow_dir(&app, &dir);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(err)? {
            let p = entry.map_err(err)?.path();
            let ok = p.is_file()
                && p.extension().and_then(|e| e.to_str()).map(|e| IMAGE_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false);
            if ok {
                out.push(image_info(&p)?);
            }
        }
        Ok(out)
    })
    .await
    .map_err(err)?
}

/// WebP thumbnail ~400 px wide in workspaces/<id>/thumbs/<hash>.webp (docs/05 §4.3).
#[tauri::command]
async fn make_thumb(app: tauri::AppHandle, path: String, workspace_id: String) -> CmdResult<ImageInfo> {
    let dir = ws_path(&format!("{workspace_id}/thumbs"))?;
    allow_dir(&app, &dir);
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(err)?;
        let img = image::open(&path).map_err(err)?;
        let w = img.width().min(400);
        let h = ((img.height() as u64 * w as u64) / img.width().max(1) as u64).max(1) as u32;
        let thumb = img.resize_exact(w, h, image::imageops::FilterType::Triangle).to_rgba8();
        let mut bytes = Vec::new();
        let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut bytes);
        thumb.write_with_encoder(enc).map_err(err)?;
        let hash = hex::encode(Sha256::digest(&bytes));
        let dest = dir.join(format!("{hash}.webp"));
        if !dest.exists() {
            let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
            std::fs::write(&tmp, &bytes).map_err(err)?;
            std::fs::rename(&tmp, &dest).map_err(err)?;
        }
        Ok(ImageInfo {
            path: dest.to_string_lossy().into_owned(),
            name: format!("{hash}.webp"),
            hash,
            width: w,
            height: h,
            mime: "image/webp".into(),
            size: bytes.len() as u64,
        })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn ws_read_text(rel: String) -> CmdResult<Option<String>> {
    let p = ws_path(&rel)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// Atomic write: tmp file in the same folder + rename (survives crashes, docs/05 §3).
#[tauri::command]
fn ws_write_text(rel: String, text: String) -> CmdResult<()> {
    let p = ws_path(&rel)?;
    let dir = p.parent().ok_or("bad path")?;
    std::fs::create_dir_all(dir).map_err(err)?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, text.as_bytes()).map_err(err)?;
    std::fs::rename(&tmp, &p).map_err(err)
}

#[tauri::command]
fn ws_list() -> CmdResult<Vec<String>> {
    let dir = workspaces_dir()?;
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    Ok(rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("workspace.json").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
fn ws_save_image(app: tauri::AppHandle, workspace_id: String, hash: String, mime: String, bytes: Vec<u8>) -> CmdResult<String> {
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad hash".into());
    }
    let ext = match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    };
    let dir = ws_path(&format!("{workspace_id}/images"))?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    allow_dir(&app, &dir);
    let dest = dir.join(format!("{hash}.{ext}"));
    if !dest.exists() {
        let actual = hex::encode(Sha256::digest(&bytes));
        if actual != hash {
            return Err("downloaded file does not match its hash".into());
        }
        let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, &bytes).map_err(err)?;
        std::fs::rename(&tmp, &dest).map_err(err)?;
    }
    Ok(dest.to_string_lossy().into_owned())
}

// ------------------------------------------------------------------ commands: network

/// Streams a file to PUT {base}/api/v1/blobs/{hash} with progress events (docs/02 §4).
#[tauri::command]
async fn upload_blob(
    base_url: String,
    token: String,
    path: String,
    hash: String,
    mime: String,
    on_progress: Channel<UploadProgress>,
) -> CmdResult<()> {
    use futures_util::StreamExt;
    let file = tokio::fs::File::open(&path).await.map_err(err)?;
    let total = file.metadata().await.map_err(err)?.len();
    let mut sent = 0u64;
    let h = hash.clone();
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024).map(move |chunk| {
        if let Ok(c) = &chunk {
            sent += c.len() as u64;
            let _ = on_progress.send(UploadProgress { hash: h.clone(), sent, total });
        }
        chunk
    });
    let res = reqwest::Client::new()
        .put(format!("{}/api/v1/blobs/{}", base_url.trim_end_matches('/'), hash))
        .bearer_auth(token)
        .header("content-type", mime)
        .header("content-length", total)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(err)?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("upload {}: HTTP {} {}", hash, res.status(), res.text().await.unwrap_or_default()))
    }
}

// ------------------------------------------------------------------ commands: token & device

#[tauri::command]
fn token_get(server: String) -> CmdResult<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &server).map_err(err)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn token_set(server: String, token: Option<String>) -> CmdResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &server).map_err(err)?;
    match token {
        Some(t) => entry.set_password(&t).map_err(err),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        },
    }
}

#[tauri::command]
fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Windows PC".into())
}

// ------------------------------------------------------------------ commands: sidecar

/// Starts `python -m komaflow_sidecar serve` from the installed engine env (ROCm, else CPU) with
/// the bundled sources on PYTHONPATH; returns None when no engine is installed (manual mode).
#[tauri::command]
fn sidecar_start(app: tauri::AppHandle, state: State<'_, SidecarState>) -> CmdResult<Option<SidecarInfo>> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};

    let envs = app_root()?.join("sidecar").join("envs");
    let python = ["torch-rocm", "torch-cpu"].iter().map(|e| envs.join(e).join("Scripts").join("python.exe")).find(|p| p.is_file());
    let Some(python) = python else { return Ok(None) };
    let src = app.path().resource_dir().map_err(err)?.join("sidecar");
    let token = uuid::Uuid::new_v4().simple().to_string();

    let mut guard = state.0.lock().map_err(err)?;
    if let Some(mut old) = guard.take() {
        let _ = old.kill();
    }
    let mut cmd = Command::new(python);
    cmd.args(["-m", "komaflow_sidecar", "serve", "--token", &token])
        .env("PYTHONPATH", &src)
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(err)?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut line = String::new();
    std::io::BufReader::new(stdout).read_line(&mut line).map_err(err)?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| format!("sidecar did not start: {e}: {line}"))?;
    let port = v["port"].as_u64().ok_or("sidecar did not report a port")?;
    *guard = Some(child);
    Ok(Some(SidecarInfo { url: format!("http://127.0.0.1:{port}"), token }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(SidecarState::default())
        .setup(|app| {
            if let Ok(dir) = workspaces_dir() {
                let _ = std::fs::create_dir_all(&dir);
                allow_dir(app.handle(), &dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_images,
            make_thumb,
            ws_read_text,
            ws_write_text,
            ws_list,
            ws_save_image,
            upload_blob,
            token_get,
            token_set,
            device_name,
            sidecar_start
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                    if let Ok(mut g) = state.0.lock() {
                        if let Some(mut c) = g.take() {
                            let _ = c.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running komaflow");
}
