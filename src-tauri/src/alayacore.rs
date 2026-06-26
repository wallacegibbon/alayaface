//! AlayaCore subprocess manager.
//!
//! Spawns `alayacore --rawio` as a child process and provides
//! access to its stdin/stdout for TLV communication.

use std::io;
use std::process::{Child, Command, Stdio};

/// Spawned alayacore process with its pipes.
pub struct CoreProcess {
    pub child: Child,
    pub stdin: std::process::ChildStdin,
    pub stdout: std::process::ChildStdout,
    pub stderr: std::process::ChildStderr,
}

/// Start alayacore with `--rawio` and return the process + pipes.
/// If `config_path` is non-empty, passes `--config-path <config_path>`.
/// If `session_path` is non-empty, passes `--session <session_path>`.
pub fn spawn(binary_path: &str, config_path: &str, session_path: &str) -> io::Result<CoreProcess> {
    let mut cmd = Command::new(binary_path);
    cmd.arg("--rawio");
    if !config_path.is_empty() {
        cmd.arg("--config-path");
        cmd.arg(config_path);
    }
    if !session_path.is_empty() {
        cmd.arg("--session");
        cmd.arg(session_path);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdin = child.stdin.take().expect("failed to capture stdin");
    let stdout = child.stdout.take().expect("failed to capture stdout");
    let stderr = child.stderr.take().expect("failed to capture stderr");

    Ok(CoreProcess {
        child,
        stdin,
        stdout,
        stderr,
    })
}

/// Helper to detect the alayacore binary.
///
/// Resolution order:
/// 1. `ALAYACORE_BIN` environment variable
/// 2. `which alayacore` (Unix) or `where alayacore` (Windows)
/// 3. Known relative/absolute paths
/// 4. Fallback to "alayacore" (assume in PATH)
pub fn find_binary() -> String {
    // 1. Check env var
    if let Ok(bin) = std::env::var("ALAYACORE_BIN") {
        if !bin.is_empty() && std::path::Path::new(&bin).exists() {
            return bin;
        }
    }

    // 2. Try `which` (Unix) or `where` (Windows)
    let which_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(which_cmd)
        .arg("alayacore")
        .output()
    {
        if output.status.success() {
            let bin = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !bin.is_empty() {
                return bin;
            }
        }
    }

    // 3. Check common locations
    for candidate in &[
        "alayacore",
        "../alayacore/alayacore",
        "./alayacore",
        "/usr/local/bin/alayacore",
        "/usr/bin/alayacore",
    ] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }

    // 4. Fallback
    "alayacore".to_string()
}
