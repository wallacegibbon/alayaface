import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type Message,
  type StagedMedia,
  MEDIA_ICON,
  shortName,
  createSessionState,
} from "./types";
import { useSessions } from "./hooks/useSessions";
import InputBar from "./components/InputBar";
import UrlModal from "./components/UrlModal";
import SessionManager from "./components/SessionManager";
import "./App.css";
import "./components/HomeScreen.css";

function App() {
  const {
    sessions, activeId, activeSess, dispatch,
    initializing, initError,
    handleCreateSession, handleCloseSession, switchSession,
    setInput, removeStaged,
  } = useSessions();

  const [showUrlModal, setShowUrlModal] = useState<string | false>(false);
  const [showSessionManager, setShowSessionManager] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [collapsedMsgs, setCollapsedMsgs] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const sendingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const notificationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ─── Window maximize state ──────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        setIsMaximized(await getCurrentWindow().isMaximized());
        unlisten = await getCurrentWindow().onResized(() => {
          getCurrentWindow().isMaximized().then(setIsMaximized);
        });
      } catch { /* */ }
    })();
    return () => { unlisten?.(); };
  }, []);

  // ─── Window dragging ────────────────────────────────────────────────
  const headerRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button, .tab, .tab-close, .tab-new, .win-btn')) return;
      getCurrentWindow().startDragging();
    };
    el.addEventListener('mousedown', onMouseDown);
    return () => el.removeEventListener('mousedown', onMouseDown);
  }, []);

  // ─── Auto-collapse newly added messages ─────────────────────────────
  useEffect(() => {
    if (!activeSess || activeSess.messages.length === 0) return;
    const ids = new Set<string>();
    // Only check the last few messages (new arrivals are at the end)
    const startIdx = Math.max(0, activeSess.messages.length - 5);
    for (let i = startIdx; i < activeSess.messages.length; i++) {
      const msg = activeSess.messages[i];
      if (msg.role === "tool" && msg.tool_id && !msg.content.startsWith("🔧")) ids.add(msg.id);
      if (msg.role === "reasoning" && msg.content.split("\n").length > 2) ids.add(msg.id);
    }
    if (ids.size === 0) return;
    setCollapsedMsgs(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) { if (!next.has(id)) { next.add(id); changed = true; } }
      return changed ? next : prev;
    });
  }, [activeSess?.messages]);

  // ─── Auto-scroll ────────────────────────────────────────────────────
  const userScrolledAwayRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      const maxScroll = container.scrollHeight - container.clientHeight;
      userScrolledAwayRef.current = container.scrollTop < maxScroll - 1;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    if (!userScrolledAwayRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    return () => container.removeEventListener("scroll", onScroll);
  }, [activeSess?.messages]);

  // ─── Close ctx menu on outside click ────────────────────────────────
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ctxMenu && ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtxMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [ctxMenu]);

  // ─── Notification auto-dismiss ──────────────────────────────────────
  useEffect(() => {
    if (!activeSess) return;
    const timers = notificationTimersRef.current;
    const now = Date.now();
    for (const n of activeSess.notifications) {
      if (timers.has(n.id)) continue;
      const remaining = Math.max(0, 4000 - (now - n.timestamp));
      const timer = setTimeout(() => {
        dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
          ...s, notifications: s.notifications.filter((nn) => nn.id !== n.id),
        })});
        timers.delete(n.id);
      }, remaining);
      timers.set(n.id, timer);
    }
    const activeIds = new Set(activeSess.notifications.map((n) => n.id));
    for (const [id, timer] of timers.entries()) {
      if (!activeIds.has(id)) { clearTimeout(timer); timers.delete(id); }
    }
  }, [activeSess?.notifications, activeSess?.id, dispatch]);

  // ─── Send / Cancel ──────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (sendingRef.current || !activeSess) return;
    if (activeSess.taskRunning) return;
    const text = activeSess.input.trim();
    if ((!text && activeSess.staged.length === 0) || !activeSess.connected) return;
    sendingRef.current = true;

    const mediaItems = activeSess.staged.map((s) => ({ media_type: s.media_type, uri: s.uri, name: s.name }));

    dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
      ...s, input: "", staged: [], statusMsg: "Sending…", sendPending: true,
    })});

    try {
      await invoke("alayacore_send_prompt", { sessionId: activeSess.id, text, media: mediaItems });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
        ...s, statusMsg: `Send error: ${err}`, sendPending: false,
        messages: [...s.messages, { id: `err-${Date.now()}`, role: "system" as const, content: `⚠ Send error: ${err}` }],
      })});
    } finally {
      sendingRef.current = false;
    }
  }, [activeSess, dispatch]);

  const handleCancelTask = useCallback(async () => {
    if (!activeId) return;
    try {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: "Cancelling…" }) });
      await invoke("alayacore_cancel", { sessionId: activeId });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Cancel error: ${err}` }) });
    }
  }, [activeId, dispatch]);

  const handleForkMessage = useCallback(async (msg: Message) => {
    const hid = msg.history_id;
    if (!hid || !activeId || !/^\d+$/.test(hid)) return;
    try {
      const newId = await invoke<string>("fork_session", { sourceSessionId: activeId, historyId: hid, binaryPath: "" });
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Forked up to history ${hid}` }) });
      dispatch({ type: "ADD_SESSION", session: createSessionState(newId) });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Fork error: ${err}` }) });
    }
  }, [activeId, dispatch]);

  const handleSetModel = useCallback(async (modelId: number) => {
    if (!activeId) return;
    try {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: "Switching model…" }) });
      await invoke("alayacore_model_set", { sessionId: activeId, modelId });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Model switch failed: ${err}` }) });
    }
  }, [activeId, dispatch]);

  // ─── Staged media handling ──────────────────────────────────────────
  const handleAddStaged = useCallback((item: StagedMedia) => {
    if (item.uri === "") {
      // URL pending — open modal
      setShowUrlModal("image");
      return;
    }
    if (!activeId) return;
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: [...s.staged, item] }) });
  }, [activeId, dispatch]);

  const handleConfirmUrl = useCallback((url: string, type: string) => {
    if (!activeId) return;
    const newItem: StagedMedia = { id: crypto.randomUUID(), media_type: type as StagedMedia["media_type"], uri: url, name: url };
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: [...s.staged, newItem] }) });
    setShowUrlModal(false);
  }, [activeId, dispatch]);

  // ─── Render helpers ─────────────────────────────────────────────────
  function renderUserContent(msg: Message) {
    const out: React.ReactNode[] = [];
    if (msg.media) {
      for (const m of msg.media) {
        if (m.media_type === "image") out.push(<div key={`media-${m.uri}`} className="media-preview"><img src={m.uri} alt={m.name || "image"} className="media-image" /></div>);
        else out.push(<div key={`media-${m.uri}`} className="media-preview"><span className="media-icon">{MEDIA_ICON[m.media_type]}</span><span className="media-name">{shortName(m.uri, m.name)}</span></div>);
      }
    }
    if (msg.content && msg.content !== "(media message)") {
      const lines = msg.content.split("\n");
      out.push(<div key="text" className="message-text">{lines.map((line, i) => <span key={i}>{line}{i < lines.length - 1 && <br />}</span>)}</div>);
    }
    return out;
  }

  // ─── Render notifications ───────────────────────────────────────────
  const renderNotifications = () => {
    if (!activeSess || activeSess.notifications.length === 0) return null;
    return (
      <div className="notifications-container">
        {activeSess.notifications.map((n) => (
          <div key={n.id} className={`notification notification-${n.type} notification-enter`}>
            <span className="notification-icon">{n.type === "error" ? "⚠" : "ℹ"}</span>
            <span className="notification-text">{n.text}</span>
            <button className="notification-close" onClick={() => {
              dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
                ...s, notifications: s.notifications.filter((nn) => nn.id !== n.id),
              })});
            }}>✕</button>
          </div>
        ))}
      </div>
    );
  };

  // ─── No session state ───────────────────────────────────────────────
  if (!activeSess) {
    return (
      <div className="app">
        <div className="hs-bg-layer">
          <div className="hs-bg-orb hs-bg-orb-1" />
          <div className="hs-bg-orb hs-bg-orb-2" />
          <div className="hs-bg-orb hs-bg-orb-3" />
        </div>
        <header className="app-header" data-tauri-drag-region>
          <div className="header-top">
            <button onClick={handleCreateSession} className="connect-btn">+ New Session</button>
            <div className="window-controls">
              <button className="win-btn" onClick={() => getCurrentWindow().minimize()} title="Minimize">
                <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <button className="win-btn" onClick={() => { getCurrentWindow().toggleMaximize(); setIsMaximized((v) => !v); }} title={isMaximized ? "Restore" : "Maximize"}>
                {isMaximized ? (
                  <svg width="12" height="12" viewBox="0 0 12 12"><rect x="4" y="1" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/><rect x="1" y="4" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2.5" width="8" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>
                )}
              </button>
              <button className="win-btn win-close" onClick={() => getCurrentWindow().close()} title="Close">
                <svg width="12" height="12" viewBox="0 0 12 12"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
        </header>
        <div className="chat-area chat-area-centered">
          {initializing ? (
            <div className="hs-container-inline">
              <div className="hs-logo"><span>AlayaFace</span></div>
              <div className="hs-tagline">Connecting…</div>
            </div>
          ) : (
            <div className="hs-container-inline">
              <div className="hs-tagline" style={{ color: "#ef4444" }}>⚠ {initError || "Failed to start"}</div>
              {initError && <div className="init-error">{initError}</div>}
              <button onClick={handleCreateSession} className="connect-btn" style={{ marginTop: 12 }}>Retry</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── Main render ────────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="hs-bg-layer">
        <div className="hs-bg-orb hs-bg-orb-1" />
        <div className="hs-bg-orb hs-bg-orb-2" />
        <div className="hs-bg-orb hs-bg-orb-3" />
      </div>

      {renderNotifications()}

      <header className="app-header" ref={headerRef}>
        <div className="header-top" />
        {sessions.length > 0 && (
          <div className="tab-bar" data-tauri-drag-region>
            {sessions.map((s, i) => (
              <div key={s.id} className={`tab ${s.id === activeId ? "tab-active" : ""} ${!s.connected ? "tab-disconnected" : ""}`} onClick={() => switchSession(s.id)}>
                <span className="tab-dot" />
                <span className="tab-label">Session {i + 1}</span>
                <button className="tab-close" onClick={(e) => { e.stopPropagation(); handleCloseSession(s.id); }} title="Close session">✕</button>
              </div>
            ))}
            <button className="tab-new" onClick={handleCreateSession} title="New session">+</button>
            <button className="tab-btn" onClick={() => setShowSessionManager(true)} title="Session manager">☰</button>
            <div className="window-controls">
              <button className="win-btn" onClick={() => getCurrentWindow().minimize()} title="Minimize">
                <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <button className="win-btn" onClick={() => { getCurrentWindow().toggleMaximize(); setIsMaximized((v) => !v); }} title={isMaximized ? "Restore" : "Maximize"}>
                {isMaximized ? (
                  <svg width="12" height="12" viewBox="0 0 12 12"><rect x="4" y="1" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/><rect x="1" y="4" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2.5" width="8" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>
                )}
              </button>
              <button className="win-btn win-close" onClick={() => getCurrentWindow().close()} title="Close">
                <svg width="12" height="12" viewBox="0 0 12 12"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
        )}
        {sessions.length === 0 && (
          <div className="header-top">
            <button onClick={handleCreateSession} className="connect-btn">+ New Session</button>
          </div>
        )}
      </header>

      <div className={`chat-area ${activeSess.messages.length === 0 ? "chat-area-centered" : ""}`}>
        {activeSess.messages.length > 0 && (
          <div ref={messagesContainerRef} className="messages">
            {activeSess.messages.map((msg) =>
              msg.role === "reasoning" ? (
                <div key={msg.id} className="message-reasoning-wrap">
                  <div className="reasoning-header" onClick={() => {
                    const lines = msg.content.split("\n").length;
                    if (lines <= 2) return;
                    const next = new Set(collapsedMsgs);
                    if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                    setCollapsedMsgs(next);
                  }}>
                    {msg.content.split("\n").length > 2 && (
                      <span className="reasoning-toggle">{collapsedMsgs.has(msg.id) ? '▶' : '▼'}</span>
                    )}
                    {msg.content.split("\n").length <= 2 && <span className="reasoning-toggle">▼</span>}
                    <span className="reasoning-label">Reasoning</span>
                  </div>
                  <div className={`message message-reasoning${msg.content.split("\n").length > 2 && collapsedMsgs.has(msg.id) ? ' reasoning-collapsed' : ''}`}
                       onClick={() => { if (collapsedMsgs.has(msg.id)) { const next = new Set(collapsedMsgs); next.delete(msg.id); setCollapsedMsgs(next); } }}>
                    {(() => {
                      const MAX_LINES = 3;
                      const lines = msg.content.split("\n");
                      if (collapsedMsgs.has(msg.id) && lines.length > MAX_LINES) {
                        const tail = lines.slice(-MAX_LINES);
                        return <><span className="reasoning-truncated">…</span>{tail.map((line, i) => <span key={i}>{line}{i < tail.length - 1 && <br />}</span>)}</>;
                      }
                      return lines.map((line, i) => <span key={i}>{line}{i < lines.length - 1 && <br />}</span>);
                    })()}
                  </div>
                </div>
              ) : msg.role === "tool" ? (
                <div key={msg.id} className="message-reasoning-wrap">
                  <div className="reasoning-header" onClick={() => {
                    const next = new Set(collapsedMsgs);
                    if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                    setCollapsedMsgs(next);
                  }}>
                    <span className="reasoning-toggle">{collapsedMsgs.has(msg.id) ? '▶' : '▼'}</span>
                    <span className={`tool-icon ${msg.is_error ? 'tool-error' : 'tool-ok'}`}>{msg.is_error ? '✗' : '✓'}</span>
                    <span className="reasoning-label">{msg.tool_name || "Tool"}</span>
                  </div>
                  {!collapsedMsgs.has(msg.id) && (
                    <div className="message-tool-content">{(() => { const lines = msg.content.split("\n"); return lines.slice(1).join("\n"); })()}</div>
                  )}
                </div>
              ) : (
                <div key={msg.id} className={`message message-${msg.role}${msg.history_id ? " message-has-ctx" : ""}`}
                     onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, message: msg }); }}>
                  <div className="message-content">
                    {msg.role === "user" ? renderUserContent(msg) : msg.content.split("\n").map((line, i) => <span key={i}>{line}{i < msg.content.split("\n").length - 1 && <br />}</span>)}
                  </div>
                </div>
              )
            )}
            {activeSess.sendPending && <div className="message message-assistant cursor-blink">▊</div>}
            <div ref={messagesEndRef} />
          </div>
        )}
        <div className={`session-input-bar${activeSess.messages.length === 0 ? ' session-input-bar-centered' : ''}`}>
          <InputBar
            session={activeSess}
            onSetInput={setInput}
            onRemoveStaged={removeStaged}
            onAddStaged={handleAddStaged}
            onSend={handleSend}
            onCancelTask={handleCancelTask}
            onSetModel={handleSetModel}
            sendingRef={sendingRef}
            inputRef={inputRef}
          />
        </div>
      </div>

      {ctxMenu && (
        <div className="ctx-overlay">
          <div ref={ctxMenuRef} className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div className="ctx-menu-item" onClick={() => { handleForkMessage(ctxMenu.message); setCtxMenu(null); }}>
              <span className="ctx-menu-icon">⎆</span>
              <span>Fork up to here</span>
            </div>
          </div>
        </div>
      )}

      {showUrlModal && <UrlModal initialType={typeof showUrlModal === "string" ? showUrlModal : "image"} onClose={() => setShowUrlModal(false)} onConfirm={handleConfirmUrl} />}

      {showSessionManager && (
        <SessionManager
          onOpenSession={(id) => {
            switchSession(id);
            setShowSessionManager(false);
          }}
          onNewSession={handleCreateSession}
          onClose={() => setShowSessionManager(false)}
          activeSessionIds={sessions.map((s) => s.id)}
        />
      )}
    </div>
  );
}

export default App;
