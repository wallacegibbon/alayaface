//! TLV protocol implementation for AlayaCore rawio mode.
//!
//! Wire format: [2-byte tag][4-byte big-endian length][N bytes of value]
//!
//! Tags:
//!   UT → stdin   User text
//!   UI → stdin   User image (data:image/...;base64,... or URL)
//!   UV → stdin   User video
//!   UA → stdin   User audio
//!   UD → stdin   User document
//!   UE → stdin   User message end — flushes staged content
//!   AT ← stdout  Assistant text delta (\x00<id>\x00<content>)
//!   AR ← stdout  Assistant reasoning delta (\x00<id>\x00<content>)
//!   AF ← stdout  Function/tool lifecycle (JSON)
//!   UF ← stdout  Function/tool result (JSON)
//!   SM ← stdout  System message (JSON: {"type":"...","data":{...}})

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

// ─── Input Tags (sent to AlayaCore stdin) ───────────────────────────

pub const TAG_USER_TEXT: &str = "UT";
pub const TAG_USER_IMAGE: &str = "UI";
pub const TAG_USER_VIDEO: &str = "UV";
pub const TAG_USER_AUDIO: &str = "UA";
pub const TAG_USER_DOC: &str = "UD";
pub const TAG_USER_END: &str = "UE";

// ─── Output Tags (received from AlayaCore stdout) ───────────────────

pub const TAG_ASSISTANT_TEXT: &str = "AT";
pub const TAG_ASSISTANT_REASONING: &str = "AR";
pub const TAG_ASSISTANT_TOOL: &str = "AF";
pub const TAG_USER_TOOL_RESULT: &str = "UF";
pub const TAG_SYSTEM_MSG: &str = "SM";

/// Encode a TLV frame into bytes.
/// Format: [2-byte tag][4-byte length (big-endian)][value bytes]
pub fn encode(tag: &str, value: &str) -> Vec<u8> {
    let data = value.as_bytes();
    let len = data.len() as u32;
    let mut buf = Vec::with_capacity(6 + len as usize);
    buf.extend_from_slice(tag.as_bytes()); // 2 bytes
    buf.extend_from_slice(&len.to_be_bytes()); // 4 bytes
    buf.extend_from_slice(data); // value bytes
    buf
}

/// A parsed TLV frame.
#[derive(Debug, Clone)]
pub struct Frame {
    pub tag: String,
    pub value: String,
}

/// Read a single TLV frame from a reader.
/// Returns None on EOF, Some(frame) on success, or an error.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut header = [0u8; 6];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let tag = std::str::from_utf8(&header[0..2])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?
        .to_string();

    let len = u32::from_be_bytes([header[2], header[3], header[4], header[5]]) as usize;

    let mut value = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut value)?;
    }

    let value_str = String::from_utf8(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    Ok(Some(Frame { tag, value: value_str }))
}

/// Write a TLV frame to a writer.
pub fn write_frame<W: Write>(writer: &mut W, tag: &str, value: &str) -> io::Result<()> {
    let buf = encode(tag, value);
    writer.write_all(&buf)
}

// ─── Delta Message Handling ─────────────────────────────────────────
//
// AT and AR deltas use NUL-delimited stream IDs:
//   \x00<stream-id>\x00<content>
//
// Same stream ID → continuation; Different → new stream.

/// Unwrap a delta value: split \x00<id>\x00<content> into (id, content).
/// Returns (id, content, true) on success, or ("", full_value, false).
pub fn unwrap_delta(value: &str) -> (String, String, bool) {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes[0] != 0u8 {
        return (String::new(), value.to_string(), false);
    }

    // Find the second NUL byte (index 0 is the first NUL)
    if let Some(end_idx) = bytes[1..].iter().position(|&b| b == 0u8) {
        let end_idx = end_idx + 1; // adjust for slice offset
        let id = String::from_utf8_lossy(&bytes[1..end_idx]).to_string();
        if id.is_empty() {
            return (String::new(), value.to_string(), false);
        }
        let content = String::from_utf8_lossy(&bytes[end_idx + 1..]).to_string();
        (id, content, true)
    } else {
        (String::new(), value.to_string(), false)
    }
}

/// Wrap content with a NUL-delimited stream ID prefix: \x00<id>\x00<content>
pub fn wrap_delta(id: &str, content: &str) -> String {
    format!("\x00{}\x00{}", id, content)
}

// ─── JSON Payload Types ──────────────────────────────────────────────

/// Tool input data (AF tag).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInputData {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
}

/// Tool output data (UF tag).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutputData {
    pub id: String,
    pub output: serde_json::Value,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_error: bool,
}

fn is_false(b: &bool) -> bool {
    !b
}

/// System message envelope (SM tag).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMsgEnvelope {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub data: serde_json::Value,
}

// ─── Streaming Mode (frame-by-frame reading) ────────────────────────

/// A streaming reader that yields TLV frames one at a time.
pub struct TlvReader<R: Read> {
    reader: R,
}

impl<R: Read> TlvReader<R> {
    pub fn new(reader: R) -> Self {
        Self { reader }
    }

    /// Read the next frame. Returns None on clean EOF.
    pub fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        read_frame(&mut self.reader)
    }
}
