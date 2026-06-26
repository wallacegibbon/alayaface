import { useState, useEffect, useCallback, useRef } from "react";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  // Clear selection when sessions list changes
  useEffect(() => {
    setSelectedIds(new Set());
    setConfirmBatchDelete(false);
  }, [sessions]);

  const isActive = (id: string) => activeSessionIds.includes(id);
  const deletableIds = sessions.filter((s) => !isActive(s.id)).map((s) => s.id);
  const selectedDeletableCount = [...selectedIds].filter((id) => deletableIds.includes(id)).length;
  const allDeletableSelected = deletableIds.length > 0 && deletableIds.every((id) => selectedIds.has(id));

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (allDeletableSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(deletableIds));
    }
  }, [allDeletableSelected, deletableIds]);

  const handleBatchDelete = useCallback(async () => {
    const toDelete = [...selectedIds].filter((id) => deletableIds.includes(id));
    if (toDelete.length === 0) return;

    setBatchDeleting(true);
    try {
      for (const id of toDelete) {
        try {
          await invoke("delete_session_dir", { sessionId: id });
        } catch { /* skip individual failures */ }
      }
      setSelectedIds(new Set());
      setConfirmBatchDelete(false);
      await loadSessions();
    } catch { /* */ } finally {
      setBatchDeleting(false);
    }
  }, [selectedIds, deletableIds, loadSessions]);

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

  const handleSingleDelete = useCallback(async (id: string) => {
    try {
      await invoke("delete_session_dir", { sessionId: id });
      await loadSessions();
    } catch (err) {
      setError(String(err));
    }
  }, [loadSessions]);

  return (
    <div className="sm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sm-panel">
        <div className="sm-header">
          <h2 className="sm-title">Session Manager</h2>
          <button className="sm-close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* ─── Toolbar ───────────────────────────────────────────── */}
        <div className="sm-toolbar">
          <button className="sm-btn sm-btn-primary" onClick={() => { onNewSession(); onClose(); }}>
            + New
          </button>
          <button className="sm-btn sm-btn-secondary" onClick={loadSessions} disabled={loading}>
            ↻
          </button>

          <div className="sm-toolbar-sep" />

          <button
            className="sm-btn sm-btn-sm sm-btn-select"
            onClick={handleSelectAll}
            disabled={deletableIds.length === 0}
            title={allDeletableSelected ? "Deselect all" : "Select all selectable"}
          >
            {allDeletableSelected ? "☐ None" : "☑ All"}
          </button>

          {selectedDeletableCount > 0 && (
            <>
              <div className="sm-toolbar-sep" />
              {confirmBatchDelete ? (
                <div className="sm-batch-confirm">
                  <span className="sm-batch-confirm-text">
                    Delete {selectedDeletableCount} session{selectedDeletableCount !== 1 ? "s" : ""}?
                  </span>
                  <button
                    className="sm-btn sm-btn-sm sm-btn-danger"
                    onClick={handleBatchDelete}
                    disabled={batchDeleting}
                  >
                    {batchDeleting ? "…" : "Yes"}
                  </button>
                  <button
                    className="sm-btn sm-btn-sm sm-btn-secondary"
                    onClick={() => setConfirmBatchDelete(false)}
                    disabled={batchDeleting}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  className="sm-btn sm-btn-sm sm-btn-danger-outline"
                  onClick={() => setConfirmBatchDelete(true)}
                >
                  🗑 Delete {selectedDeletableCount}
                </button>
              )}
            </>
          )}
        </div>

        {error && (
          <div className="sm-error">
            <span>⚠ {error}</span>
            <button className="sm-error-close" onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* ─── List ──────────────────────────────────────────────── */}
        {loading ? (
          <div className="sm-loading">Loading sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="sm-empty">
            <div className="sm-empty-icon">📂</div>
            <div className="sm-empty-text">No saved sessions found</div>
            <div className="sm-empty-sub">Create a new session to get started</div>
          </div>
        ) : (
          <div className="sm-list" ref={listRef}>
            {sessions.map((s) => {
              const active = isActive(s.id);
              const selected = selectedIds.has(s.id);
              return (
                <div
                  key={s.id}
                  className={`sm-item${active ? " sm-item-active" : ""}${selected ? " sm-item-selected" : ""}`}
                >
                  {/* Checkbox — disabled for active sessions */}
                  <label className="sm-checkbox-wrapper" title={active ? "Cannot delete active session" : "Select for batch operation"}>
                    <input
                      type="checkbox"
                      className="sm-checkbox"
                      checked={selected}
                      disabled={active}
                      onChange={() => handleToggleSelect(s.id)}
                    />
                    <span className="sm-checkbox-visual" />
                  </label>

                  {/* Status dot */}
                  <div className="sm-item-indicator">
                    <span className={`sm-dot${active ? " sm-dot-active" : ""}`} />
                  </div>

                  {/* Info */}
                  <div className="sm-item-info">
                    <div className="sm-item-name">
                      {s.id.slice(0, 8)}…{s.id.slice(-4)}
                      {active && <span className="sm-badge sm-badge-active">active</span>}
                    </div>
                    <div className="sm-item-meta">
                      <span>{formatDate(s.created_at)}</span>
                      {s.has_session_file && <span className="sm-badge">has data</span>}
                      {!s.has_session_file && <span className="sm-badge sm-badge-empty">empty</span>}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="sm-item-actions">
                    {active ? (
                      <span className="sm-active-label">Running</span>
                    ) : (
                      <button
                        className="sm-btn sm-btn-sm sm-btn-open"
                        onClick={() => handleOpen(s.id)}
                        disabled={openingId === s.id}
                      >
                        {openingId === s.id ? "…" : "Open"}
                      </button>
                    )}
                    {!active && (
                      <button
                        className="sm-btn sm-btn-sm sm-btn-icon"
                        onClick={() => handleSingleDelete(s.id)}
                        title="Delete session"
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ─── Footer ──────────────────────────────────────────────── */}
        <div className="sm-footer">
          <span className="sm-footer-text">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""} on disk
            {activeSessionIds.length > 0 && ` · ${activeSessionIds.length} active`}
            {selectedDeletableCount > 0 && (
              <span className="sm-footer-selected">
                · {selectedDeletableCount} selected
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

export default SessionManager;
