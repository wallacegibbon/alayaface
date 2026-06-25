//! AlayaCore subprocess manager.
//!
//! Spawns `alayacore --rawio` as a child process and provides
//! access to its stdin/stdout for TLV communication.

use std::io;
use std::process::{Child, Command, Stdio};

/// Spawned alayacore process with its pipes.
pub struct CoreProcess {
    #[allow(dead_code)]
    pub child: Child,
    pub stdin: std::process::ChildStdin,
    pub stdout: std::process::ChildStdout,
    pub stderr: std::process::ChildStderr,
}

/// Start alayacore with `--rawio` and return the process + pipes.
pub fn spawn(binary_path: &str) -> io::Result<CoreProcess> {
    let mut child = Command::new(binary_path)
        .arg("--rawio")
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
/// Tries PATH first, then checks common locations.
pub fn find_binary() -> String {
    // Check if "alayacore" exists in PATH via `which`
    if let Ok(output) = std::process::Command::new("which")
        .arg("alayacore")
        .output()
    {
        if output.status.success() {
            let bin = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !bin.is_empty() {
                return bin;
            }
        }
    }

    // Check common locations relative to this project
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

    // Fallback — hope it's in PATH
    "alayacore".to_string()
}
