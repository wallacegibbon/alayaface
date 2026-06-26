import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SessionManager.css";

interface SessionDirInfo {
  id: string;
  has_session_file: boolean;
  created_at: string;
}

interface SessionManagerProps {
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
  activeSessionIds: string[];
}

function formatDate(unixTs: string): string {
  const ts = parseInt(unixTs, 10);
  if (!ts) return "Unknown";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SessionManager({ onOpenSession, onNewSession, onClose, activeSessionIds }: SessionManagerProps) {
  const [sessions, setSessions] = useState<SessionDirInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dirs = await invoke<SessionDirInfo[]>("list_session_dirs");
      setSessions(dirs);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(true);
    try {
      await invoke("delete_session_dir", { sessionId: id });
      setConfirmDelete(null);
      await loadSessions();
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }, [loadSessions]);

  const handleOpen = useCallback(async (id: string) => {
    setOpeningId(id);
    try {
      const resumedId = await invoke<string>("resume_session", {
        sessionId: id,
        binaryPath: "",
      });
      onOpenSession(resumedId);
    } catch (err) {
      setError(String(err));
    } finally {
      setOpeningId(null);
    }
  }, [onOpenSession]);

  const isActive = (id: string) => activeSessionIds.includes(id);

  return (
    <div className="sm-overlay">
      <div className="sm-panel">
        <div className="sm-header">
          <h2 className="sm-title">Session Manager</h2>
          <button className="sm-close" onClick={onClose} title="Close">✕</button>
        </div>

        <div className="sm-toolbar">
          <button className="sm-btn sm-btn-primary" onClick={() => { onNewSession(); onClose(); }}>
            + New Session
          </button>
          <button className="sm-btn sm-btn-secondary" onClick={loadSessions} disabled={loading}>
            ↻ Refresh
          </button>
        </div>

        {error && (
          <div className="sm-error">
            <span>⚠ {error}</span>
            <button className="sm-error-close" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div className="sm-loading">Loading sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="sm-empty">
            <div className="sm-empty-icon">📂</div>
            <div className="sm-empty-text">No saved sessions found</div>
            <div className="sm-empty-sub">Create a new session to get started</div>
          </div>
        ) : (
          <div className="sm-list">
            {sessions.map((s) => (
              <div key={s.id} className={`sm-item${isActive(s.id) ? " sm-item-active" : ""}`}>
                <div className="sm-item-indicator">
                  <span className={`sm-dot${isActive(s.id) ? " sm-dot-active" : ""}`} />
                </div>
                <div className="sm-item-info">
                  <div className="sm-item-name">
                    {s.id.slice(0, 8)}…{s.id.slice(-4)}
                    {isActive(s.id) && <span className="sm-badge sm-badge-active">active</span>}
                  </div>
                  <div className="sm-item-meta">
                    <span>{formatDate(s.created_at)}</span>
                    {s.has_session_file && <span className="sm-badge">has data</span>}
                    {!s.has_session_file && <span className="sm-badge sm-badge-empty">empty</span>}
                  </div>
                </div>
                <div className="sm-item-actions">
                  {isActive(s.id) ? (
                    <span className="sm-active-label">Running</span>
                  ) : (
                    <button
                      className="sm-btn sm-btn-sm sm-btn-open"
                      onClick={() => handleOpen(s.id)}
                      disabled={openingId === s.id}
                    >
                      {openingId === s.id ? "…" : "▶ Open"}
                    </button>
                  )}
                  {confirmDelete === s.id ? (
                    <div className="sm-confirm-delete">
                      <span className="sm-confirm-text">Delete?</span>
                      <button
                        className="sm-btn sm-btn-sm sm-btn-danger"
                        onClick={() => handleDelete(s.id)}
                        disabled={deleting}
                      >
                        {deleting ? "…" : "Yes"}
                      </button>
                      <button
                        className="sm-btn sm-btn-sm sm-btn-secondary"
                        onClick={() => setConfirmDelete(null)}
                        disabled={deleting}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      className="sm-btn sm-btn-sm sm-btn-danger"
                      onClick={() => setConfirmDelete(s.id)}
                      title="Delete session"
                      disabled={isActive(s.id)}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="sm-footer">
          <span className="sm-footer-text">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""} on disk
            {activeSessionIds.length > 0 && ` · ${activeSessionIds.length} active`}
          </span>
        </div>
      </div>
    </div>
  );
}

export default SessionManager;
