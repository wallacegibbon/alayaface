//! AlayaFace — A Tauri GUI frontend for AlayaCore.
//!
//! Spawns `alayacore --rawio` as a subprocess, communicates via TLV frames,
//! and streams events to the React frontend.
//!
//! Supports multiple sessions — each session is an independent alayacore process
//! with its own stdin/stdout/stderr pipes, identified by a UUID.

mod alayacore;
mod tlv;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use uuid::Uuid;

// Use eprintln for logging since Tauri may not set up `log` crate properly
macro_rules! alog {
    ($($arg:tt)*) => {
        eprintln!("[alayaface] {}", format_args!($($arg)*))
    };
}

// ─── Directory Management ────────────────────────────────────────────

/// Default model config template — in key-value block format (alayacore's
/// custom format, NOT TOML/JSON). Written to `~/.alayaface/config/model.conf`
/// on first run when `~/.alayacore/` is not available.
///
/// Format per model block:
///   name: "..."
///   protocol_type: "..."
///   base_url: "..."
///   api_key: "..."
///   model_name: "..."
///   context_limit: <int>
///   max_tokens: <int>
///
/// Multiple blocks are separated by blank lines.
const DEFAULT_MODEL_CONF: &str = r##"name: "Placeholder"
protocol_type: "openai"
base_url: "https://api.openai.com/v1"
api_key: ""
model_name: "gpt-4o"
context_limit: 128000
max_tokens: 4096
"##;

/// Get alayaface's base directory (~/.alayaface).
fn alayaface_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE")) // Windows
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".alayaface")
}

/// Ensure `~/.alayaface/` exists with default config template.
/// Creates directories and default files if missing.
///
/// Initialization logic (first run):
/// 1. If `~/.alayacore/` exists → copy its config files as initial template
/// 2. Otherwise → write hardcoded minimal defaults
///
/// Returns `(config_template_dir, sessions_dir)`.
fn ensure_alayaface_dirs() -> Result<(PathBuf, PathBuf), String> {
    let base = alayaface_dir();
    let config = base.join("config");
    let sessions = base.join("sessions");

    std::fs::create_dir_all(&config)
        .map_err(|e| format!("Cannot create {:?}: {}", config, e))?;
    std::fs::create_dir_all(&sessions)
        .map_err(|e| format!("Cannot create {:?}: {}", sessions, e))?;

    // Check if template config is empty (no model.conf) — first run
    let model_conf = config.join("model.conf");
    if !model_conf.exists() {
        // Try to copy from ~/.alayacore/ first
        let alayacore_dir = {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".alayacore")
        };

        if alayacore_dir.exists() {
            // Copy model.conf, runtime.conf, themes/ from alayacore's config
            let src_model = alayacore_dir.join("model.conf");
            if src_model.exists() {
                std::fs::copy(&src_model, &model_conf)
                    .map_err(|e| format!("Cannot copy {:?} → {:?}: {}", src_model, model_conf, e))?;
            } else {
                std::fs::write(&model_conf, DEFAULT_MODEL_CONF)
                    .map_err(|e| format!("Cannot write {:?}: {}", model_conf, e))?;
            }

            let src_runtime = alayacore_dir.join("runtime.conf");
            let runtime_conf = config.join("runtime.conf");
            if src_runtime.exists() {
                std::fs::copy(&src_runtime, &runtime_conf)
                    .map_err(|e| format!("Cannot copy {:?}: {}", src_runtime, e))?;
            } else {
                std::fs::write(&runtime_conf, "{}")
                    .map_err(|e| format!("Cannot write {:?}: {}", runtime_conf, e))?;
            }

            let src_themes = alayacore_dir.join("themes");
            let dst_themes = config.join("themes");
            if src_themes.exists() {
                copy_dir(&src_themes, &dst_themes)?;
            } else {
                std::fs::create_dir_all(&dst_themes)
                    .map_err(|e| format!("Cannot create {:?}: {}", dst_themes, e))?;
            }
        } else {
            // No ~/.alayacore — write hardcoded defaults
            std::fs::write(&model_conf, DEFAULT_MODEL_CONF)
                .map_err(|e| format!("Cannot write {:?}: {}", model_conf, e))?;

            let runtime_conf = config.join("runtime.conf");
            std::fs::write(&runtime_conf, "{}")
                .map_err(|e| format!("Cannot write {:?}: {}", runtime_conf, e))?;

            let themes = config.join("themes");
            std::fs::create_dir_all(&themes)
                .map_err(|e| format!("Cannot create {:?}: {}", themes, e))?;
        }
    }

    Ok((config, sessions))
}

/// Copy template config into a session directory.
/// Source: `~/.alayaface/config/` → Dest: `~/.alayaface/sessions/<uuid>/config/`
/// Also creates an empty `session.md` file.
fn create_session_dir(sessions_dir: &PathBuf, uuid: &str) -> Result<PathBuf, String> {
    let session_dir = sessions_dir.join(uuid);
    let dst_config = session_dir.join("config");
    let session_file = session_dir.join("session.md");

    // Copy template config
    let template = sessions_dir
        .parent()
        .map(|p| p.join("config"))
        .unwrap_or_else(|| alayaface_dir().join("config"));

    copy_dir(&template, &dst_config)?;

    // Create empty session file
    std::fs::write(&session_file, "")
        .map_err(|e| format!("Cannot create {:?}: {}", session_file, e))?;

    Ok(session_dir)
}

/// Recursively copy a directory (cross-platform, no symlinks).
fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst)
        .map_err(|e| format!("Cannot create {:?}: {}", dst, e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Cannot read {:?}: {}", src, e))? {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        let ty = entry.file_type().map_err(|e| format!("Stat error: {}", e))?;
        let name = entry.file_name();
        if ty.is_dir() {
            copy_dir(&entry.path(), &dst.join(&name))?;
        } else {
            std::fs::copy(&entry.path(), &dst.join(&name))
                .map_err(|e| format!("Copy error: {}", e))?;
        }
    }
    Ok(())
}

// ─── Session Handle ──────────────────────────────────────────────────

/// Kill a child process and wait for it to exit, with a 3-second timeout.
/// Returns the child back so it can be used again if needed (though typically
/// the child is consumed after killing).
fn kill_child(child: &mut std::process::Child) {
    let _ = child.stdin.take(); // close stdin to signal EOF
    let _ = child.kill();
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > std::time::Duration::from_secs(3) => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => break,
        }
    }
}

struct SessionHandle {
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    connected: Arc<AtomicBool>,
    stderr_log: Arc<Mutex<Vec<String>>>,
    /// The child process — kept alive so we can explicitly kill it on close.
    /// Uses std::sync::Mutex so Drop can access it (Drop runs in sync context).
    child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
    /// Path to the session's directory on disk (~/.alayaface/sessions/<uuid>/).
    #[allow(dead_code)]
    session_dir: PathBuf,
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                kill_child(&mut child);
            }
        }
    }
}

// ─── Application State ───────────────────────────────────────────────

/// Map of session_id → SessionHandle.
struct Sessions(Arc<Mutex<HashMap<String, SessionHandle>>>);

/// Cached model list — populated from the first `model_list` SM message
/// received from any session. Avoids spawning temp processes.
/// Uses std::sync::Mutex because it's accessed from sync threads (stdout reader).
struct ModelCache(Arc<std::sync::Mutex<Vec<serde_json::Value>>>);

// ─── Event Payloads (all include session_id) ─────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FrameEvent {
    pub session_id: String,
    pub tag: String,
    pub raw_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<serde_json::Value>,
    /// User-role content parts include a `user_content_type` field so the
    /// frontend can distinguish user echoes (UT on stdout) from the direction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_content_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeltaEvent {
    pub session_id: String,
    pub history_id: String,
    pub content: String,
    pub tag: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusEvent {
    pub session_id: String,
    pub connected: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub media_type: String,
    pub uri: String,
}

/// User-role content tags that appear on stdout (echoes).
fn is_user_echo_tag(tag: &str) -> bool {
    matches!(tag, "UT" | "UI" | "UV" | "UA" | "UD")
}

// ─── Background stdout reader ────────────────────────────────────────

fn spawn_stdout_reader(
    app: AppHandle,
    session_id: String,
    mut stdout: std::process::ChildStdout,
    connected: Arc<AtomicBool>,
    model_cache: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
) {
    std::thread::spawn(move || {
        let sid = session_id;

        // Helper: reap the child process to prevent zombies
        let reap_child = || {
            if let Ok(mut guard) = child.lock() {
                if let Some(mut c) = guard.take() {
                    kill_child(&mut c);
                }
            }
        };

        loop {
            match tlv::read_frame(&mut stdout) {
                Ok(Some(frame)) => {
                    let tag = &frame.tag;
                    let raw_value = &frame.value;

                    // SM frames: cache model_list if present
                    if tag == "SM" {
                        if let Ok(env) = serde_json::from_str::<tlv::SystemMsgEnvelope>(raw_value) {
                            if env.msg_type == "model_list" {
                                if let Some(arr) = env.data.get("models").and_then(|v| v.as_array()) {
                                    let mut cache = model_cache.lock().unwrap();
                                    *cache = arr.clone();
                                }
                            }
                        }
                    }

                    // Delta events (AT/AR) — may or may not have a NUL prefix
                    if tag == "AT" || tag == "AR" {
                        let (history_id, content, has_delta) = tlv::unwrap_delta(raw_value);
                        if has_delta {
                            let hid = history_id.clone();
                            let ct = content.clone();
                            let _ = app.emit("tlv-delta", DeltaEvent {
                                session_id: sid.clone(),
                                history_id,
                                content,
                                tag: tag.clone(),
                            });
                            // Also emit as tlv-frame for non-delta consumers
                            let _ = app.emit("tlv-frame", FrameEvent {
                                session_id: sid.clone(),
                                tag: tag.clone(),
                                raw_value: raw_value.clone(),
                                history_id: Some(hid),
                                content: Some(ct),
                                json: None,
                                user_content_type: None,
                            });
                            continue;
                        }
                        // No NUL prefix (e.g. session replay) — send as frame
                        let _ = app.emit("tlv-frame", FrameEvent {
                            session_id: sid.clone(),
                            tag: tag.clone(),
                            raw_value: raw_value.clone(),
                            history_id: None,
                            content: Some(raw_value.clone()),
                            json: None,
                            user_content_type: None,
                        });
                        // Also emit as delta so frontend can render it
                        let _ = app.emit("tlv-delta", DeltaEvent {
                            session_id: sid.clone(),
                            history_id: String::new(),
                            content: raw_value.clone(),
                            tag: tag.clone(),
                        });
                        continue;
                    }

                    // Parse JSON payloads for AF/UF
                    let mut json_val = None;
                    let mut history_id = None;
                    let mut content = None;

                    if tag == "AF" || tag == "UF" {
                        let (sid_val, raw_content, has_delta) = tlv::unwrap_delta(raw_value);
                        if has_delta {
                            history_id = Some(sid_val);
                            content = Some(raw_content.clone());
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw_content) {
                                json_val = Some(v);
                            }
                        } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw_value) {
                            json_val = Some(v);
                            content = Some(raw_value.clone());
                        }
                    } else if tag == "SM" {
                        if let Ok(env) = serde_json::from_str::<tlv::SystemMsgEnvelope>(raw_value) {
                            json_val = Some(serde_json::json!({
                                "type": env.msg_type,
                                "data": env.data
                            }));
                            content = Some(raw_value.clone());
                        }
                    } else {
                        // User echo tags (UT/UI/UV/UA/UD on stdout) or others
                        let (sid_val, raw_content, has_delta) = tlv::unwrap_delta(raw_value);
                        if has_delta {
                            history_id = Some(sid_val);
                            content = Some(raw_content);
                        } else {
                            content = Some(raw_value.clone());
                        }
                    }

                    let user_content_type = if is_user_echo_tag(tag) {
                        Some(tag.to_string())
                    } else {
                        None
                    };

                    let _ = app.emit("tlv-frame", FrameEvent {
                        session_id: sid.clone(),
                        tag: tag.clone(),
                        raw_value: raw_value.clone(),
                        history_id,
                        content,
                        json: json_val,
                        user_content_type,
                    });
                }
                Ok(None) => {
                    connected.store(false, Ordering::SeqCst);
                    reap_child();
                    let _ = app.emit("core-status", StatusEvent {
                        session_id: sid.clone(),
                        connected: false,
                        message: "Connection closed".to_string(),
                    });
                    break;
                }
                Err(e) => {
                    connected.store(false, Ordering::SeqCst);
                    reap_child();
                    let _ = app.emit("core-status", StatusEvent {
                        session_id: sid.clone(),
                        connected: false,
                        message: format!("Read error: {e}"),
                    });
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_collector(
    stderr: std::process::ChildStderr,
    log: Arc<Mutex<Vec<String>>>,
) {
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let mut guard = log.blocking_lock();
                    guard.push(l);
                }
                Err(_) => break,
            }
        }
    });
}

// ─── Tauri Commands ──────────────────────────────────────────────────

/// Create a new session — spawns an alayacore subprocess.
/// Returns the session_id.
#[tauri::command]
async fn create_session(
    app: AppHandle,
    binary_path: String,
    config_path: String,
    sessions: State<'_, Sessions>,
    model_cache: State<'_, ModelCache>,
) -> Result<String, String> {
    // Ensure ~/.alayaface/ exists with default config
    let (_template_dir, sessions_dir) = ensure_alayaface_dirs()?;

    let bin = if binary_path.is_empty() {
        alayacore::find_binary()
    } else {
        binary_path
    };

    let session_id = Uuid::new_v4().to_string();

    // Create session directory with its own config + session.md
    let session_dir = create_session_dir(&sessions_dir, &session_id)?;

    // Resolve config path: prefer explicit, otherwise use session's own config
    let effective_config = if config_path.is_empty() {
        session_dir.join("config").to_string_lossy().to_string()
    } else {
        config_path
    };

    // Session file path
    let session_file = session_dir.join("session.md").to_string_lossy().to_string();

    alog!("Spawning alayacore: {} --rawio --config-path {} --session {}", &bin, &effective_config, &session_file);

    let proc = alayacore::spawn(&bin, &effective_config, &session_file)
        .map_err(|e| format!("Failed to start alayacore: {e}"))?;

    let connected = Arc::new(AtomicBool::new(true));
    let stderr_log = Arc::new(Mutex::new(Vec::new()));
    let stdin = Arc::new(Mutex::new(proc.stdin));
    let child = Arc::new(std::sync::Mutex::new(Some(proc.child)));

    let handle = SessionHandle {
        stdin: stdin.clone(),
        connected: connected.clone(),
        stderr_log: stderr_log.clone(),
        child: child.clone(),
        session_dir: session_dir.clone(),
    };

    sessions.0.lock().await.insert(session_id.clone(), handle);

    // Spawn background readers
    spawn_stderr_collector(proc.stderr, stderr_log);
    spawn_stdout_reader(
        app.clone(),
        session_id.clone(),
        proc.stdout,
        connected,
        model_cache.0.clone(),
        child.clone(),
    );

    let _ = app.emit("core-status", StatusEvent {
        session_id: session_id.clone(),
        connected: true,
        message: format!("Connected to alayacore ({})", bin),
    });

    Ok(session_id)
}

/// Resume an existing session from disk — starts alayacore with the
/// session's session.md and config. Returns the session_id (same as the
/// one on disk).
#[tauri::command]
async fn resume_session(
    app: AppHandle,
    session_id: String,
    binary_path: String,
    sessions: State<'_, Sessions>,
    model_cache: State<'_, ModelCache>,
) -> Result<String, String> {
    let sessions_dir = alayaface_dir().join("sessions").join(&session_id);
    let session_file = sessions_dir.join("session.md");
    let config_dir = sessions_dir.join("config");

    if !sessions_dir.exists() {
        return Err(format!("Session directory not found: {:?}", sessions_dir));
    }
    if !session_file.exists() {
        return Err(format!("Session file not found: {:?}", session_file));
    }
    if !config_dir.exists() {
        return Err(format!("Config directory not found: {:?}", config_dir));
    }

    // Check if already running
    {
        let map = sessions.0.lock().await;
        if map.contains_key(&session_id) {
            return Err("Session is already active".to_string());
        }
    }

    let bin = if binary_path.is_empty() {
        alayacore::find_binary()
    } else {
        binary_path
    };

    let config_path = config_dir.to_string_lossy().to_string();
    let session_path = session_file.to_string_lossy().to_string();

    alog!("Resuming session {} from {:?}", &session_id, &session_file);

    let proc = alayacore::spawn(&bin, &config_path, &session_path)
        .map_err(|e| format!("Failed to start alayacore: {e}"))?;

    let connected = Arc::new(AtomicBool::new(true));
    let stderr_log = Arc::new(Mutex::new(Vec::new()));
    let stdin = Arc::new(Mutex::new(proc.stdin));
    let child = Arc::new(std::sync::Mutex::new(Some(proc.child)));

    let handle = SessionHandle {
        stdin: stdin.clone(),
        connected: connected.clone(),
        stderr_log: stderr_log.clone(),
        child: child.clone(),
        session_dir: sessions_dir,
    };

    sessions.0.lock().await.insert(session_id.clone(), handle);

    spawn_stderr_collector(proc.stderr, stderr_log);
    spawn_stdout_reader(
        app.clone(),
        session_id.clone(),
        proc.stdout,
        connected,
        model_cache.0.clone(),
        child.clone(),
    );

    let _ = app.emit("core-status", StatusEvent {
        session_id: session_id.clone(),
        connected: true,
        message: format!("Resumed session ({})", bin),
    });

    Ok(session_id)
}

/// Close a session — kills the alayacore subprocess and removes it.
#[tauri::command]
async fn close_session(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let mut map = sessions.0.lock().await;
    if let Some(handle) = map.remove(&session_id) {
        // Explicitly kill the child process in a blocking task
        let child_opt = handle.child.lock().unwrap().take();
        if let Some(mut child) = child_opt {
            let _ = tokio::task::spawn_blocking(move || {
                kill_child(&mut child);
            })
            .await;
        }
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

/// List all active session IDs.
#[tauri::command]
async fn list_sessions(
    sessions: State<'_, Sessions>,
) -> Result<Vec<String>, String> {
    let map = sessions.0.lock().await;
    Ok(map.keys().cloned().collect())
}

/// List all session directories on disk (from ~/.alayaface/sessions/).
/// Returns session info: id, has_session_file, created_at.
#[derive(Serialize)]
pub struct SessionDirInfo {
    pub id: String,
    pub has_session_file: bool,
    pub created_at: String,
}

#[tauri::command]
async fn list_session_dirs() -> Result<Vec<SessionDirInfo>, String> {
    let sessions_dir = alayaface_dir().join("sessions");
    if !sessions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Cannot read sessions dir: {e}"))?
        .filter_map(|e| e.ok())
        .collect();
    // Sort by modification time (newest first)
    entries.sort_by_key(|e| std::cmp::Reverse(e.path().metadata().ok().and_then(|m| m.modified().ok())));

    for entry in entries {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let session_file = path.join("session.md");
        let has_session_file = session_file.exists();

        let created_at = path
            .metadata()
            .ok()
            .and_then(|m| m.created().ok())
            .map(|t| {
                let secs = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                // Return Unix timestamp — frontend can format it
                secs.to_string()
            })
            .unwrap_or_else(|| "0".to_string());

        result.push(SessionDirInfo {
            id,
            has_session_file,
            created_at,
        });
    }

    Ok(result)
}

/// Permanently delete a session directory from disk.
/// If the session is currently running, closes it first.
#[tauri::command]
async fn delete_session_dir(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    // Close if running
    {
        let mut map = sessions.0.lock().await;
        if let Some(handle) = map.remove(&session_id) {
            let child_opt = handle.child.lock().unwrap().take();
            if let Some(mut child) = child_opt {
                let _ = tokio::task::spawn_blocking(move || {
                    kill_child(&mut child);
                }).await;
            }
        }
    }

    // Remove directory
    let session_dir = alayaface_dir().join("sessions").join(&session_id);
    if session_dir.exists() {
        std::fs::remove_dir_all(&session_dir)
            .map_err(|e| format!("Cannot delete {:?}: {}", session_dir, e))?;
    }

    Ok(())
}

/// Check if a specific session is still connected.
#[tauri::command]
async fn session_connected(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<bool, String> {
    let map = sessions.0.lock().await;
    match map.get(&session_id) {
        Some(h) => Ok(h.connected.load(Ordering::SeqCst)),
        None => Err("Session not found".to_string()),
    }
}

// ─── Session I/O ─────────────────────────────────────────────────────

fn get_session<'a>(
    map: &'a HashMap<String, SessionHandle>,
    session_id: &str,
) -> Result<&'a SessionHandle, String> {
    map.get(session_id).ok_or_else(|| "Session not found".to_string())
}

async fn send_raw_to_session(
    map: &HashMap<String, SessionHandle>,
    session_id: &str,
    tag: &str,
    value: &str,
) -> Result<(), String> {
    let handle = get_session(map, session_id)?;

    // Check if still connected
    if !handle.connected.load(Ordering::SeqCst) {
        return Err("Session is disconnected".to_string());
    }

    let mut stdin = handle.stdin.lock().await;
    tlv::write_frame(&mut *stdin, tag, value)
        .map_err(|e| format!("Write error: {e}"))?;
    stdin.flush().map_err(|e| format!("Flush error: {e}"))?;
    Ok(())
}

/// Send a text prompt to a session.
#[tauri::command]
async fn alayacore_send_message(
    session_id: String,
    text: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &text).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Send a multi-modal prompt (text + optional media) to a session.
#[tauri::command]
async fn alayacore_send_prompt(
    session_id: String,
    text: String,
    media: Vec<MediaItem>,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let handle = get_session(&map, &session_id)?;

    // Check if still connected
    if !handle.connected.load(Ordering::SeqCst) {
        return Err("Session is disconnected".to_string());
    }

    let mut stdin = handle.stdin.lock().await;

    for item in &media {
        let tag = match item.media_type.as_str() {
            "image" => tlv::TAG_USER_IMAGE,
            "audio" => tlv::TAG_USER_AUDIO,
            "video" => tlv::TAG_USER_VIDEO,
            "document" => tlv::TAG_USER_DOC,
            _ => return Err(format!("Unknown media type: {}", item.media_type)),
        };
        tlv::write_frame(&mut *stdin, tag, &item.uri)
            .map_err(|e| format!("Write error: {e}"))?;
    }

    if !text.is_empty() {
        tlv::write_frame(&mut *stdin, tlv::TAG_USER_TEXT, &text)
            .map_err(|e| format!("Write error: {e}"))?;
    }

    tlv::write_frame(&mut *stdin, tlv::TAG_USER_END, "")
        .map_err(|e| format!("Write error: {e}"))?;
    stdin.flush().map_err(|e| format!("Flush error: {e}"))?;

    Ok(())
}

/// Switch the active model for a session.
#[tauri::command]
async fn alayacore_model_set(
    session_id: String,
    model_id: u32,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let cmd = format!(":model_set {}", model_id);
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Cancel the running task in a session.
#[tauri::command]
async fn alayacore_cancel(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, ":cancel").await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Save the session to a file (sends `:save <filename>` command).
#[tauri::command]
async fn alayacore_save(
    session_id: String,
    filename: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let cmd = if filename.is_empty() {
        ":save".to_string()
    } else {
        format!(":save {}", filename)
    };
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Fork the session up to a history ID (sends `:fork <history_id> <filename>`).
#[tauri::command]
async fn alayacore_fork(
    session_id: String,
    history_id: String,
    filename: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let cmd = format!(":fork {} {}", history_id, filename);
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Fork a session up to a history ID, creating a new session.
/// 1. Creates a new session directory with its own config
/// 2. Tells the source session's alayacore to :fork <history_id> <target_session_file>
/// 3. Starts a new alayacore with the forked session file
/// Returns the new session_id.
#[tauri::command]
async fn fork_session(
    app: AppHandle,
    source_session_id: String,
    history_id: String,
    binary_path: String,
    sessions: State<'_, Sessions>,
    model_cache: State<'_, ModelCache>,
) -> Result<String, String> {
    // 1. Create new session directory
    let (_template_dir, sessions_dir) = ensure_alayaface_dirs()?;
    let new_id = Uuid::new_v4().to_string();
    let new_session_dir = create_session_dir(&sessions_dir, &new_id)?;
    let target_file = new_session_dir.join("session.md").to_string_lossy().to_string();
    let config_path = new_session_dir.join("config").to_string_lossy().to_string();

    alog!("Forking session {} up to history {} → {}", &source_session_id, &history_id, &target_file);

    // 2. Tell source session's alayacore to fork (synchronous command)
    {
        let map = sessions.0.lock().await;
        let cmd = format!(":fork {} {}", history_id, target_file);
        send_raw_to_session(&map, &source_session_id, tlv::TAG_USER_TEXT, &cmd).await?;
        send_raw_to_session(&map, &source_session_id, tlv::TAG_USER_END, "").await?;
    }

    // 3. Wait for the session file to be written by alayacore
    let target_path = std::path::Path::new(&target_file);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut seen_size = 0u64;
    loop {
        if let Ok(meta) = target_path.metadata() {
            let len = meta.len();
            if len > 0 && len == seen_size {
                // File size stable — write is complete
                alog!("Fork target file written ({} bytes)", len);
                break;
            }
            if len > 0 {
                seen_size = len; // Remember size, check stability next iteration
            }
        }
        if std::time::Instant::now() > deadline {
            if seen_size > 0 {
                alog!("Fork target file size changed during wait, using anyway ({} bytes)", seen_size);
                break;
            }
            return Err("Timeout waiting for fork to complete".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // 4. Spawn a new alayacore with the forked session
    let bin = if binary_path.is_empty() {
        alayacore::find_binary()
    } else {
        binary_path
    };

    let proc = alayacore::spawn(&bin, &config_path, &target_file)
        .map_err(|e| format!("Failed to start forked alayacore: {e}"))?;

    let connected = Arc::new(AtomicBool::new(true));
    let stderr_log = Arc::new(Mutex::new(Vec::new()));
    let stdin = Arc::new(Mutex::new(proc.stdin));
    let child = Arc::new(std::sync::Mutex::new(Some(proc.child)));

    let handle = SessionHandle {
        stdin: stdin.clone(),
        connected: connected.clone(),
        stderr_log: stderr_log.clone(),
        child: child.clone(),
        session_dir: new_session_dir,
    };

    sessions.0.lock().await.insert(new_id.clone(), handle);

    spawn_stderr_collector(proc.stderr, stderr_log);
    spawn_stdout_reader(
        app.clone(),
        new_id.clone(),
        proc.stdout,
        connected,
        model_cache.0.clone(),
        child.clone(),
    );

    let _ = app.emit("core-status", StatusEvent {
        session_id: new_id.clone(),
        connected: true,
        message: format!("Forked session up to history {}", history_id),
    });

    Ok(new_id)
}

/// Set reasoning level — sends `:reason <level>` (0=off, 1=normal, 2=max).
#[tauri::command]
async fn alayacore_reason(
    session_id: String,
    level: u32,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let cmd = format!(":reason {}", level);
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Switch theme — sends `:theme_set <name>`.
#[tauri::command]
async fn alayacore_theme_set(
    session_id: String,
    name: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let cmd = format!(":theme_set {}", name);
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Reload model configs — sends `:model_load`.
#[tauri::command]
async fn alayacore_model_load(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, ":model_load").await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Apply edited model config — sends `:model_sync <config>`.
#[tauri::command]
async fn alayacore_model_sync(
    session_id: String,
    config: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let cmd = format!(":model_sync {}", config);
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Set video FPS and resolution — sends `:video_config <fps> <0|1>`.
#[tauri::command]
async fn alayacore_video_config(
    session_id: String,
    fps: u32,
    res: u32,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let cmd = format!(":video_config {} {}", fps, res);
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Retry the last prompt — sends `:continue`.
#[tauri::command]
async fn alayacore_continue(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, ":continue").await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Summarize conversation to reduce token usage — sends `:summarize`.
/// ⚠️ Replaces entire conversation history with a summary.
#[tauri::command]
async fn alayacore_summarize(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, ":summarize").await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Send a tool confirmation response — sends `:confirm <id> yes|no`.
#[tauri::command]
async fn alayacore_confirm(
    session_id: String,
    id: String,
    allowed: bool,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let answer = if allowed { "yes" } else { "no" };
    let cmd = format!(":confirm {} {}", id, answer);
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, &cmd).await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Send a raw TLV frame to a session.
#[tauri::command]
async fn alayacore_send_raw_frame(
    session_id: String,
    tag: String,
    value: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, &tag, &value).await
}

/// Get stderr log for a session.
#[tauri::command]
async fn get_stderr_log(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<Vec<String>, String> {
    let map = sessions.0.lock().await;
    let log = {
        let handle = get_session(&map, &session_id)?;
        handle.stderr_log.lock().await.clone()
    };
    Ok(log)
}

/// Get cached models from any running session.
/// Falls back to spawning a temporary alayacore process if no session is active
/// or no model_list has been received yet.
#[tauri::command]
async fn list_models(
    binary_path: String,
    config_path: String,
    model_cache: State<'_, ModelCache>,
    sessions: State<'_, Sessions>,
) -> Result<Vec<serde_json::Value>, String> {
    // First, try the cache from running sessions
    {
        let cache = model_cache.0.lock().unwrap();
        if !cache.is_empty() {
            return Ok(cache.clone());
        }
    }

    // If there's an active session that's connected, request model_list via :model_load
    {
        let map = sessions.0.lock().await;
        // Try to find any connected session and ask it for model_list
        for (_sid, handle) in map.iter() {
            if handle.connected.load(Ordering::SeqCst) {
                // Don't block — just send the command, the cache will be updated
                // when the session responds with model_list
                let mut stdin = handle.stdin.lock().await;
                let _ = tlv::write_frame(&mut *stdin, tlv::TAG_USER_TEXT, ":model_load");
                let _ = tlv::write_frame(&mut *stdin, tlv::TAG_USER_END, "");
                let _ = stdin.flush();
                // Return whatever we have in cache (might be empty if first time)
                let cache = model_cache.0.lock().unwrap();
                if !cache.is_empty() {
                    return Ok(cache.clone());
                }
                // If cache is still empty, fall through to spawn temp process
                break;
            }
        }
    }

    // Fallback: spawn a temporary alayacore process
    let bin = if binary_path.is_empty() {
        alayacore::find_binary()
    } else {
        binary_path
    };

    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--rawio");
    if !config_path.is_empty() {
        cmd.arg("--config-path");
        cmd.arg(&config_path);
    }
    let mut child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start alayacore: {e}"))?;

    // Close stdin immediately so alayacore gets EOF
    drop(child.stdin.take());

    let mut stdout = child.stdout.take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let mut models = Vec::new();

    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(5);

    loop {
        if start.elapsed() > timeout {
            break;
        }

        match tlv::read_frame(&mut stdout) {
            Ok(Some(frame)) => {
                if frame.tag == "SM" {
                    if let Ok(env) = serde_json::from_str::<tlv::SystemMsgEnvelope>(&frame.value) {
                        if env.msg_type == "model_list" {
                            if let Some(arr) = env.data.get("models").and_then(|v| v.as_array()) {
                                models = arr.clone();
                                // Also update the cache
                                let mut cache = model_cache.0.lock().unwrap();
                                *cache = models.clone();
                            }
                            break;
                        }
                    }
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    // Kill the temp process cleanly
    drop(stdout);
    let _ = child.kill();
    let _ = child.wait();

    Ok(models)
}

// ─── App Entry Point ─────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Sessions(Arc::new(Mutex::new(HashMap::new()))))
        .manage(ModelCache(Arc::new(std::sync::Mutex::new(Vec::new()))))
        .invoke_handler(tauri::generate_handler![
            create_session,
            resume_session,
            close_session,
            list_sessions,
            list_session_dirs,
            delete_session_dir,
            session_connected,
            alayacore_send_message,
            alayacore_send_prompt,
            alayacore_model_set,
            alayacore_cancel,
            alayacore_save,
            alayacore_fork,
            fork_session,
            alayacore_reason,
            alayacore_theme_set,
            alayacore_model_load,
            alayacore_model_sync,
            alayacore_video_config,
            alayacore_continue,
            alayacore_summarize,
            alayacore_confirm,
            alayacore_send_raw_frame,
            get_stderr_log,
            list_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
