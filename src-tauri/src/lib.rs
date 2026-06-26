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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use uuid::Uuid;

// ─── Session Handle ──────────────────────────────────────────────────

struct SessionHandle {
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    connected: Arc<AtomicBool>,
    stderr_log: Arc<Mutex<Vec<String>>>,
}

// ─── Application State ───────────────────────────────────────────────

/// Map of session_id → SessionHandle.
struct Sessions(Arc<Mutex<HashMap<String, SessionHandle>>>);

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

// ─── Background stdout reader ────────────────────────────────────────

fn spawn_stdout_reader(
    app: AppHandle,
    session_id: String,
    mut stdout: std::process::ChildStdout,
    connected: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let sid = session_id; // move session_id into the closure
        loop {
            match tlv::read_frame(&mut stdout) {
                Ok(Some(frame)) => {
                    let tag = &frame.tag;
                    let raw_value = &frame.value;

                    // Delta events (AT/AR)
                    if tag == "AT" || tag == "AR" {
                        let (history_id, content, has_delta) = tlv::unwrap_delta(raw_value);
                        if has_delta {
                            let _ = app.emit("tlv-delta", DeltaEvent {
                                session_id: sid.clone(),
                                history_id,
                                content,
                                tag: tag.clone(),
                            });
                            continue;
                        }
                    }

                    // Parse JSON payloads for AF/UF/SM
                    let mut json_val = None;
                    let mut history_id = None;
                    let mut content = None;

                    if tag == "SM" {
                        if let Ok(env) = serde_json::from_str::<tlv::SystemMsgEnvelope>(raw_value) {
                            json_val = Some(serde_json::json!({
                                "type": env.msg_type,
                                "data": env.data
                            }));
                        }
                    } else if tag == "AF" || tag == "UF" {
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
                    } else {
                        let (sid_val, raw_content, has_delta) = tlv::unwrap_delta(raw_value);
                        if has_delta {
                            history_id = Some(sid_val);
                            content = Some(raw_content);
                        } else {
                            content = Some(raw_value.clone());
                        }
                    }

                    let _ = app.emit("tlv-frame", FrameEvent {
                        session_id: sid.clone(),
                        tag: tag.clone(),
                        raw_value: raw_value.clone(),
                        history_id,
                        content,
                        json: json_val,
                    });
                }
                Ok(None) => {
                    connected.store(false, Ordering::SeqCst);
                    let _ = app.emit("core-status", StatusEvent {
                        session_id: sid.clone(),
                        connected: false,
                        message: "Connection closed".to_string(),
                    });
                    break;
                }
                Err(e) => {
                    connected.store(false, Ordering::SeqCst);
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
    sessions: State<'_, Sessions>,
) -> Result<String, String> {
    let bin = if binary_path.is_empty() {
        alayacore::find_binary()
    } else {
        binary_path
    };

    let proc = alayacore::spawn(&bin).map_err(|e| format!("Failed to start alayacore: {e}"))?;
    let session_id = Uuid::new_v4().to_string();

    let connected = Arc::new(AtomicBool::new(true));
    let stderr_log = Arc::new(Mutex::new(Vec::new()));
    let stdin = Arc::new(Mutex::new(proc.stdin));

    let handle = SessionHandle {
        stdin: stdin.clone(),
        connected: connected.clone(),
        stderr_log: stderr_log.clone(),
    };

    sessions.0.lock().await.insert(session_id.clone(), handle);

    // Spawn background readers
    spawn_stderr_collector(proc.stderr, stderr_log);
    spawn_stdout_reader(app.clone(), session_id.clone(), proc.stdout, connected);

    let _ = app.emit("core-status", StatusEvent {
        session_id: session_id.clone(),
        connected: true,
        message: format!("Connected to alayacore ({})", bin),
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
    if map.remove(&session_id).is_none() {
        return Err("Session not found".to_string());
    }
    // Dropping the SessionHandle closes stdin (sends EOF) and drops the process
    Ok(())
}

/// List all active session IDs.
#[tauri::command]
async fn list_sessions(
    sessions: State<'_, Sessions>,
) -> Result<Vec<String>, String> {
    let map = sessions.0.lock().await;
    Ok(map.keys().cloned().collect())
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
    let mut stdin = handle.stdin.lock().await;
    tlv::write_frame(&mut *stdin, tag, value)
        .map_err(|e| format!("Write error: {e}"))?;
    stdin.flush().map_err(|e| format!("Flush error: {e}"))?;
    Ok(())
}

/// Send a text prompt to a session.
#[tauri::command]
async fn send_message(
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
async fn send_prompt(
    session_id: String,
    text: String,
    media: Vec<MediaItem>,
    app: AppHandle,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    let handle = get_session(&map, &session_id)?;
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

    let display_text = if !text.is_empty() { text.clone() } else { "(media message)".to_string() };

    // Emit a PROMPT frame so the frontend can display the user message
    let _ = app.emit("tlv-frame", FrameEvent {
        session_id: session_id.clone(),
        tag: "PROMPT".to_string(),
        raw_value: String::new(),
        history_id: None,
        content: Some(display_text),
        json: Some(serde_json::json!({
            "text": text,
            "media": media,
        })),
    });

    Ok(())
}

/// Switch the active model for a session.
#[tauri::command]
async fn set_model(
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
async fn cancel_task(
    session_id: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_TEXT, ":cancel").await?;
    send_raw_to_session(&map, &session_id, tlv::TAG_USER_END, "").await
}

/// Save the session to a file (sends `:save <filename>` command).
#[tauri::command]
async fn save_session(
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
async fn fork_session(
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

/// Send a raw TLV frame to a session.
#[tauri::command]
async fn send_raw_frame(
    session_id: String,
    tag: String,
    value: String,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, &tag, &value).await
}

/// Send a tool confirmation response to a session.
#[tauri::command]
async fn send_tool_confirm(
    session_id: String,
    id: String,
    allowed: bool,
    sessions: State<'_, Sessions>,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "type": "tool_confirm",
        "data": { "id": id, "allowed": allowed }
    });
    let map = sessions.0.lock().await;
    send_raw_to_session(&map, &session_id, tlv::TAG_SYSTEM_MSG, &payload.to_string()).await
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

/// List available models by briefly spawning alayacore and reading the model list.
#[tauri::command]
async fn list_models(binary_path: String) -> Result<Vec<serde_json::Value>, String> {
    let bin = if binary_path.is_empty() {
        alayacore::find_binary()
    } else {
        binary_path
    };

    let proc = alayacore::spawn(&bin).map_err(|e| format!("Failed to start alayacore: {e}"))?;

    let mut stdout = proc.stdout;
    let mut models = Vec::new();

    // Read frames until we get the model_list or timeout
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
                            }
                            break;
                        }
                        if env.msg_type == "model" {
                            // Also capture active model info if needed
                        }
                    }
                }
                // Ignore other frames
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }

    // Kill the temporary process
    drop(proc.child);

    Ok(models)
}

// ─── App Entry Point ─────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Sessions(Arc::new(Mutex::new(HashMap::new()))))
        .invoke_handler(tauri::generate_handler![
            create_session,
            close_session,
            list_sessions,
            session_connected,
            send_message,
            send_prompt,
            set_model,
            cancel_task,
            save_session,
            fork_session,
            send_raw_frame,
            send_tool_confirm,
            get_stderr_log,
            list_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
