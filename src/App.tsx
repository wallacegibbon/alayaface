import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type DeltaEvent,
  type FrameEvent,
  type StatusEvent,
  type MediaItem,
  type StagedMedia,
  type Message,
  type SessionState,
  MEDIA_ICON,
  uploadItems,
  shortName,
  fileToDataUri,
  createSessionState,
  isUserEchoTag,
  echoTagToMediaType,
} from "./types";
import "./App.css";
import "./components/HomeScreen.css";

// ─── Types ───────────────────────────────────────────────────────────

interface UrlModalProps {
  initialType: string;
  onClose: () => void;
  onConfirm: (url: string, type: string) => void;
}

// ─── Reducer for session state ───────────────────────────────────────

type SessionAction =
  | { type: "UPDATE_SESSION"; sessionId: string; updater: (s: SessionState) => SessionState }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "ADD_SESSION"; session: SessionState }
  | { type: "SET_ACTIVE"; sessionId: string | null };

interface SessionReducerState {
  sessions: SessionState[];
  activeId: string | null;
  /** Updaters queued before the target session was registered. */
  pendingUpdates: Map<string, Array<(s: SessionState) => SessionState>>;
}

function sessionReducer(state: SessionReducerState, action: SessionAction): SessionReducerState {
  switch (action.type) {
    case "UPDATE_SESSION": {
      const exists = state.sessions.some((s) => s.id === action.sessionId);
      if (!exists) {
        const pending = new Map(state.pendingUpdates);
        const arr = pending.get(action.sessionId) || [];
        pending.set(action.sessionId, [...arr, action.updater]);
        return { ...state, pendingUpdates: pending };
      }
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.sessionId ? action.updater(s) : s
        ),
      };
    }
    case "REMOVE_SESSION": {
      const remaining = state.sessions.filter((s) => s.id !== action.sessionId);
      const pending = new Map(state.pendingUpdates);
      pending.delete(action.sessionId);
      return {
        ...state,
        sessions: remaining,
        pendingUpdates: pending,
        activeId: state.activeId === action.sessionId
          ? (remaining.length > 0 ? remaining[remaining.length - 1].id : null)
          : state.activeId,
      };
    }
    case "ADD_SESSION": {
      const pending = new Map(state.pendingUpdates);
      const updates = pending.get(action.session.id) || [];
      pending.delete(action.session.id);
      const session = updates.reduce((s, fn) => fn(s), action.session);
      return {
        ...state,
        sessions: [...state.sessions, session],
        pendingUpdates: pending,
        activeId: action.session.id,
      };
    }
    case "SET_ACTIVE":
      return { ...state, activeId: action.sessionId };
  }
  return state;
}

// ─── URL Modal ───────────────────────────────────────────────────────

function UrlModal({ initialType, onClose, onConfirm }: UrlModalProps) {
  const [url, setUrl] = useState("");
  const [type, setType] = useState(initialType);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = (e: React.FormEvent) => { e.preventDefault(); const t = url.trim(); if (t) onConfirm(t, type); };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Attach from URL</h3>
        <form onSubmit={submit}>
          <select value={type} onChange={(e) => setType(e.target.value)} className="modal-select">
            <option value="image">Image</option><option value="audio">Audio</option><option value="video">Video</option><option value="document">Document</option>
          </select>
          <input ref={ref} type="url" placeholder="https://example.com/image.jpg" value={url} onChange={(e) => setUrl(e.target.value)} className="modal-input" />
          <div className="modal-buttons">
            <button type="button" onClick={onClose} className="modal-cancel">Cancel</button>
            <button type="submit" disabled={!url.trim()} className="modal-confirm">Attach</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────

function App() {
  const [{ sessions, activeId }, dispatch] = useReducer(sessionReducer, {
    sessions: [],
    activeId: null,
    pendingUpdates: new Map(),
  });
  const [showUrlModal, setShowUrlModal] = useState<string | false>(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [collapsedMsgs, setCollapsedMsgs] = useState<Set<string>>(new Set());
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const sendingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const uploadTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const uploadDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const notificationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const activeSess = sessions.find((s) => s.id === activeId);

  // ─── Event handler functions (extracted for readability) ─────────────

  const handleDeltaEvent = useCallback((ev: DeltaEvent) => {
    const { session_id, history_id, content, tag } = ev;
    const role = tag === "AT" ? "assistant" : "reasoning";
    dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => {
      const existing = s.historyContents.get(history_id);
      const newHistoryContents = new Map(s.historyContents);
      const newMsgs = [...s.messages];

      if (existing !== undefined) {
        newHistoryContents.set(history_id, existing + content);
        const idx = newMsgs.findIndex((m) => m.history_id === history_id && m.role === role);
        if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: existing + content };
      } else {
        newHistoryContents.set(history_id, content);
        newMsgs.push({ id: `hist-${history_id}-${Date.now()}`, role, content, history_id });
      }
      // Clear sendPending once the assistant starts responding (AT/AR means the
      // send was processed even if the user echo was missed due to a race).
      return { ...s, historyContents: newHistoryContents, messages: newMsgs, sendPending: false };
    }});
  }, [dispatch]);

  const handleUserEchoFrame = useCallback((s: SessionState, tag: string, history_id: string | null, content: string | null): SessionState => {
    const mediaType = echoTagToMediaType(tag);
    const textContent = tag === "UT" ? (content || "") : "";

    // Dedup: skip if this exact history_id was already processed
    if (history_id && s.processedEchoIds.has(history_id)) {
      return s;
    }

    const newEchoIds = history_id ? new Set(s.processedEchoIds).add(history_id) : s.processedEchoIds;
    const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null;
    const sameTurn = lastMsg?.role === "user" && !history_id
      ? false
      : lastMsg?.role === "user";

    if (sameTurn) {
      const newMsgs = [...s.messages];
      if (tag === "UT") {
        const sep = lastMsg!.content ? '\n\n' : '';
        newMsgs[newMsgs.length - 1] = {
          ...lastMsg!,
          content: lastMsg!.content + sep + textContent,
          history_id: history_id || lastMsg!.history_id,
        };
      } else if (mediaType) {
        const existingMedia = lastMsg!.media || [];
        newMsgs[newMsgs.length - 1] = {
          ...lastMsg!,
          media: [...existingMedia, { media_type: mediaType, uri: content! }],
          history_id: history_id || lastMsg!.history_id,
        };
      }
      return { ...s, messages: newMsgs, processedEchoIds: newEchoIds, sendPending: false };
    }

    // New turn
    const newMsg: Message = {
      id: `user-${history_id || Date.now()}`,
      role: "user",
      content: textContent,
      media: mediaType && content ? [{ media_type: mediaType, uri: content }] : undefined,
      history_id: history_id || undefined,
    };
    return { ...s, messages: [...s.messages, newMsg], processedEchoIds: newEchoIds, sendPending: false };
  }, []);

  const handleSystemMsg = useCallback((s: SessionState, sm: { type?: string; data?: Record<string, unknown> }): SessionState => {
    const d = sm.data || {};
    switch (sm.type) {
      case "task": {
        const td = d as Record<string, unknown>;
        const tokens = (td.context ?? td.tokens ?? td.context_tokens ?? td.usage) as number | undefined;
        const done = !(td.in_progress as boolean);
        return { ...s, taskRunning: !done, contextTokens: tokens ?? s.contextTokens, statusMsg: done ? "Task complete" : "Task in progress…", sendPending: done ? false : s.sendPending };
      }
      case "error": {
        const ed = d as { text?: string };
        return { ...s, notifications: [...s.notifications, { id: `err-${Date.now()}`, type: "error" as const, text: ed.text || "Unknown error", timestamp: Date.now() }] };
      }
      case "notify": {
        const nd = d as { text?: string };
        return { ...s, notifications: [...s.notifications, { id: `notify-${Date.now()}`, type: "notify" as const, text: nd.text || "", timestamp: Date.now() }] };
      }
      case "model_list": {
        const ml = d as { models?: { id?: number; name?: string }[] };
        if (ml.models) return { ...s, models: ml.models.filter((m) => m.id !== undefined && m.name).map((m) => ({ id: m.id!, name: m.name! })) };
        return s;
      }
      case "model": {
        const md = d as Record<string, unknown>;
        const tokens = (md.context_tokens ?? md.context ?? md.tokens) as number | undefined;
        return { ...s, activeModelId: (md.active_id as number) ?? s.activeModelId, activeModelName: (md.active_name as string) ?? s.activeModelName, contextLimit: (md.context_limit as number) ?? s.contextLimit, contextTokens: tokens ?? s.contextTokens };
      }
      case "tool_confirm": {
        const cd = d as { id?: string };
        return { ...s, messages: [...s.messages, { id: `confirm-${Date.now()}`, role: "system" as const, content: `🔧 Tool confirmation: ${cd.id}` }] };
      }
    }
    return s;
  }, []);

  const handleToolCallFrame = useCallback((s: SessionState, json: Record<string, unknown>, history_id: string | null): SessionState => {
    const td = json as { id?: string; name?: string; input?: Record<string, unknown> };
    const toolId = td.id || "";
    const newToolCalls = new Map(s.toolCalls);
    const newMsgs = [...s.messages];
    if (td.name) {
      newToolCalls.set(toolId, { id: toolId, name: td.name, started: true, input_received: false });
      newMsgs.push({ id: `tool-${toolId}`, role: "tool" as const, content: `🔧 **${td.name}**`, tool_id: toolId, tool_name: td.name, history_id: history_id || undefined });
    } else if (td.input) {
      const tc = newToolCalls.get(toolId);
      if (tc) { tc.input = td.input; tc.input_received = true; }
      const idx = newMsgs.findIndex((m) => m.tool_id === toolId);
      if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: `🔧 **${newMsgs[idx].tool_name || "Tool"}**\n\`\`\`json\n${JSON.stringify(td.input, null, 2)}\n\`\`\`` };
    }
    return { ...s, toolCalls: newToolCalls, messages: newMsgs };
  }, []);

  const handleToolResultFrame = useCallback((s: SessionState, json: Record<string, unknown>, history_id: string | null): SessionState => {
    const rd = json as { id?: string; is_error?: boolean; output?: unknown };
    const toolId = rd.id || "";
    const isError = rd.is_error || false;
    let outStr = "";
    if (rd.output) {
      if (Array.isArray(rd.output)) outStr = rd.output.map((i: Record<string, unknown>) => i.text || i.uri || JSON.stringify(i)).join("\n");
      else outStr = JSON.stringify(rd.output, null, 2);
    }
    if (outStr.length > 500) outStr = outStr.slice(0, 500) + "\n… (truncated)";
    const tc = s.toolCalls.get(toolId);
    const toolName = tc?.name || "Tool";
    const newMsgs = [...s.messages];
    const idx = newMsgs.findIndex((m) => m.tool_id === toolId);
    if (idx >= 0) {
      const existing = newMsgs[idx].content;
      const prefix = isError ? `❌ **${toolName}** (error)` : `✅ **${toolName}**`;
      const inputPart = existing.split("\n").slice(1).join("\n").trim();
      const newContent = inputPart
        ? `${prefix}\n\nInput:\n\`\`\`\n${inputPart}\n\`\`\`\n\nOutput:\n\`\`\`\n${outStr}\n\`\`\``
        : `${prefix}\n\`\`\`\n${outStr}\n\`\`\``;
      newMsgs[idx] = { ...newMsgs[idx], content: newContent, is_error: isError, history_id: history_id || newMsgs[idx].history_id };
    }
    return { ...s, messages: newMsgs };
  }, []);

  const handleFrameEvent = useCallback((ev: FrameEvent) => {
    const { session_id, tag, json, history_id, content } = ev;

    dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => {
      // User echo frames (UT/UI/UV/UA/UD on stdout)
      if (isUserEchoTag(tag)) {
        return handleUserEchoFrame(s, tag, history_id, content);
      }

      let newS = s;

      // SM: system messages
      if (tag === "SM" && json) {
        const sm = json as { type?: string; data?: Record<string, unknown> };
        return handleSystemMsg(newS, sm);
      }

      // AF: tool call frames
      if (tag === "AF" && json) {
        return handleToolCallFrame(newS, json, history_id);
      }

      // UF: tool result frames
      if (tag === "UF" && json) {
        return handleToolResultFrame(newS, json, history_id);
      }

      return newS;
    }});
  }, [handleUserEchoFrame, handleSystemMsg, handleToolCallFrame, handleToolResultFrame]);

  const handleStatusEvent = useCallback((ev: StatusEvent) => {
    const { session_id, connected, message } = ev;
    dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => ({
      ...s, connected, statusMsg: message,
    })});
  }, [dispatch]);

  // ─── Initialize: set up listeners FIRST, then create session ────────
  // This avoids a race where alayacore emits events (model_list, etc.)
  // before the Tauri event listeners are registered, which would cause
  // the first session to miss the model list.
  useEffect(() => {
    let cancelled = false;
    let createdSessionId: string | null = null;
    const unlisteners: UnlistenFn[] = [];

    (async () => {
      // 1. Register all event listeners first
      const un1 = await listen<DeltaEvent>("tlv-delta", (ev) => {
        handleDeltaEvent(ev.payload);
      });
      if (cancelled) { un1(); return; }
      unlisteners.push(un1);

      const un2 = await listen<FrameEvent>("tlv-frame", (ev) => {
        handleFrameEvent(ev.payload);
      });
      if (cancelled) { un2(); return; }
      unlisteners.push(un2);

      const un3 = await listen<StatusEvent>("core-status", (ev) => {
        handleStatusEvent(ev.payload);
      });
      if (cancelled) { un3(); return; }
      unlisteners.push(un3);

      // 2. Listeners are now registered — safe to create the session
      try {
        const id = await invoke<string>("create_session", { binaryPath: "", configPath: "" });
        createdSessionId = id;
        if (!cancelled) {
          const newSess = createSessionState(id);
          dispatch({ type: "ADD_SESSION", session: newSess });
        } else {
          // StrictMode double-fire: close the orphaned process
          try { await invoke("close_session", { sessionId: id }); } catch { /* */ }
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to auto-create session:", err);
          setInitError(String(err));
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => { try { fn(); } catch { /* */ } });
      // If a session was created and never used, close it
      if (createdSessionId !== null) {
        invoke("close_session", { sessionId: createdSessionId }).catch(() => {});
      }
    };
  }, []);

  // ─── Initialize maximized state ─────────────────────────────────────
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

  // ─── Window dragging via callback ref ────────────────────────────────
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

  // ─── Auto-collapse completed tool calls ─────────────────────────────
  useEffect(() => {
    if (!activeSess) return;
    const ids = new Set<string>();
    for (const msg of activeSess.messages) {
      if (msg.role === "tool" && msg.tool_id && !msg.content.startsWith("🔧")) {
        ids.add(msg.id);
      }
      if (msg.role === "reasoning" && msg.content.split("\n").length > 2) {
        ids.add(msg.id);
      }
    }
    setCollapsedMsgs(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) { next.add(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [activeSess?.messages]);

  // Scroll to bottom — only if user hasn't scrolled away
  const userScrolledAwayRef = useRef(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll + scroll listener — combined so we only attach when container exists
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const onScroll = () => {
      // Immediately disable following on ANY scroll away from exact bottom
      const maxScroll = container.scrollHeight - container.clientHeight;
      userScrolledAwayRef.current = container.scrollTop < maxScroll - 1;
    };
    container.addEventListener("scroll", onScroll, { passive: true });

    // Auto-scroll to bottom only if user is at the bottom
    if (!userScrolledAwayRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }

    return () => container.removeEventListener("scroll", onScroll);
  }, [activeSess?.messages]);

  // ─── Close dropdowns on outside click ────────────────────────────────

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ctxMenu && ctxMenuRef.current && !ctxMenuRef.current.contains(event.target as Node)) {
        setCtxMenu(null);
      }
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(event.target as Node)) {
        setShowUploadMenu(false);
      }
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setShowModelMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [ctxMenu]);

  // ─── Auto-dismiss notifications ──────────────────────────────────────

  useEffect(() => {
    if (!activeSess) return;

    const timers = notificationTimersRef.current;
    const now = Date.now();

    for (const n of activeSess.notifications) {
      // Only set a timer if one doesn't already exist for this notification
      if (timers.has(n.id)) continue;

      const elapsed = now - n.timestamp;
      const remaining = Math.max(0, 4000 - elapsed);
      const timer = setTimeout(() => {
        dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
          ...s,
          notifications: s.notifications.filter((nn) => nn.id !== n.id),
        })});
        timers.delete(n.id);
      }, remaining);
      timers.set(n.id, timer);
    }

    // Clean up timers for notifications that were already removed
    const activeIds = new Set(activeSess.notifications.map((n) => n.id));
    for (const [id, timer] of timers.entries()) {
      if (!activeIds.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }

    // No return cleanup needed — individual timers clean themselves up
  }, [activeSess?.notifications]);

  // ─── Session lifecycle ──────────────────────────────────────────────

  const handleCreateSession = useCallback(async () => {
    try {
      setInitError(null);
      const id = await invoke<string>("create_session", { binaryPath: "", configPath: "" });
      const newSess = createSessionState(id);
      dispatch({ type: "ADD_SESSION", session: newSess });
    } catch (err) {
      console.error("Failed to create session:", err);
      setInitError(String(err));
    }
  }, []);

  const handleCloseSession = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { sessionId: id });
    } catch { /* */ }
    dispatch({ type: "REMOVE_SESSION", sessionId: id });
  }, []);

  const switchSession = useCallback((id: string) => {
    dispatch({ type: "SET_ACTIVE", sessionId: id });
    setShowUrlModal(false);
  }, []);

  // ─── Input handling ─────────────────────────────────────────────────

  const setInput = useCallback((val: string) => {
    if (!activeId) return;
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, input: val }) });
  }, [activeId]);

  const confirmUrl = useCallback((url: string, type: string) => {
    if (!activeId) return;
    const newItem: StagedMedia = { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri: url, name: url };
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: [...s.staged, newItem] }) });
    setShowUrlModal(false);
  }, [activeId]);

  const removeStaged = useCallback((id: string) => {
    if (!activeId) return;
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: s.staged.filter((m) => m.id !== id) }) });
  }, [activeId]);

  // ─── Send / Cancel ──────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (sendingRef.current || !activeSess) return;
    if (activeSess.taskRunning) return;
    const text = activeSess.input.trim();
    if ((!text && activeSess.staged.length === 0) || !activeSess.connected) return;
    sendingRef.current = true;

    const mediaItems: MediaItem[] = activeSess.staged.map((s) => ({ media_type: s.media_type, uri: s.uri, name: s.name }));

    // Don't create an optimistic user message — wait for alayacore echoes.
    // Show "Sending…" status until echoes arrive.
    dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
      ...s,
      input: "",
      staged: [],
      statusMsg: "Sending…",
      sendPending: true,
    })});

    try {
      await invoke("alayacore_send_prompt", { sessionId: activeSess.id, text, media: mediaItems });
      // Status will be updated when echoes arrive
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeSess.id, updater: (s) => ({
        ...s,
        statusMsg: `Send error: ${err}`,
        sendPending: false,
        messages: [...s.messages, { id: `err-${Date.now()}`, role: "system" as const, content: `⚠ Send error: ${err}` }],
      })});
    } finally {
      sendingRef.current = false;
    }
  }, [activeSess, activeId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Let arrow keys (up/down) scroll naturally within the textarea
  }, [handleSend]);

  const handleCancelTask = useCallback(async () => {
    if (!activeId) return;
    try {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: "Cancelling…" }) });
      await invoke("alayacore_cancel", { sessionId: activeId });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Cancel error: ${err}` }) });
    }
  }, [activeId]);

  const handleForkMessage = useCallback(async (msg: Message) => {
    const hid = msg.history_id;
    if (!hid || !activeId || !/^\d+$/.test(hid)) return;
    try {
      const newId = await invoke<string>("fork_session", {
        sourceSessionId: activeId,
        historyId: hid,
        binaryPath: "",
      });
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Forked up to history ${hid}` }) });
      const newSess = createSessionState(newId);
      dispatch({ type: "ADD_SESSION", session: newSess });
      // SET_ACTIVE is handled by ADD_SESSION (it sets activeId = session.id)
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Fork error: ${err}` }) });
    }
  }, [activeId]);

  const handleSetModel = useCallback(async (modelId: number) => {
    if (!activeId) return;
    try {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: "Switching model…" }) });
      await invoke("alayacore_model_set", { sessionId: activeId, modelId });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Model switch failed: ${err}` }) });
    }
  }, [activeId]);

  // ─── Upload / Model menu handlers ────────────────────────────────────

  const handleUploadClick = useCallback((accept: string, type: string) => {
    setShowUploadMenu(false);
    if (type === "url") {
      setShowUrlModal("image");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";

    const cleanup = () => {
      input.onchange = null;
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        try {
          const uri = await fileToDataUri(file);
          if (!activeId) return;
          const newItem: StagedMedia = { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri, name: file.name };
          dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: [...s.staged, newItem] }) });
        } catch { /* */ }
      }
      cleanup();
    };
    // Handle cancellation (Escape key closes picker) to prevent DOM leak
    input.addEventListener("cancel", cleanup);
    document.body.appendChild(input);
    input.click();
  }, [activeId]);

  const handleModelClick = useCallback(() => {
    setShowModelMenu((prev) => !prev);
  }, []);

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

  // ─── Render helpers: Search box (HomeScreen-style) ───────────────────

  const renderSearchBox = () => {
    if (!activeSess) return null;
    return (
      <div className="hs-search-wrapper">
        <div className="hs-search-form">
          {/* Staged media chips inside the search box */}
          {activeSess.staged.length > 0 && (
            <div className="hs-staged-row">
              {activeSess.staged.map((m) => (
                <div key={m.id} className="hs-staged-chip">
                  <span className="hs-staged-icon">{MEDIA_ICON[m.media_type]}</span>
                  <span className="hs-staged-name">{shortName(m.uri, m.name)}</span>
                  <button className="hs-staged-remove" onClick={() => removeStaged(m.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="hs-search-input"
            placeholder={activeSess.staged.length > 0 ? "Add a message…" : "Type a message…"}
            value={activeSess.input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeSess.connected}
            rows={1}
          />
          <div className="hs-search-controls">
            <div className="hs-controls-left">
              <div className="hs-menu-container" ref={uploadMenuRef}>
                <button
                  ref={uploadTriggerRef}
                  type="button"
                  className="hs-control-button"
                  onClick={() => setShowUploadMenu(!showUploadMenu)}
                  title="Attach files"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </button>
                {showUploadMenu && (
                  <div ref={uploadDropdownRef} className="hs-dropdown-menu hs-upload-menu hs-dropdown-up">
                    {uploadItems.map((item, index) => (
                      <div key={index} className="hs-menu-item" onClick={() => handleUploadClick(item.accept, item.type)}>
                        <span className="hs-menu-item-icon">{item.icon}</span>
                        <span className="hs-menu-item-label">{item.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="hs-controls-right">
              {activeSess.models.length > 0 && (
                <div className="hs-menu-container" ref={modelMenuRef}>
                  <button
                    ref={modelTriggerRef}
                    type="button"
                    className="hs-control-button-with-text hs-model-button"
                    onClick={handleModelClick}
                    title="Select model"
                  >
                    <span className="hs-model-button-label">
                      {activeSess.activeModelName || "Model"}
                    </span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </button>
                  {showModelMenu && (
                    <div ref={modelDropdownRef} className="hs-dropdown-menu hs-model-menu hs-dropdown-up" style={{ maxHeight: 260, overflowY: "auto" }}>
                      {activeSess.models.map((model) => (
                        <div
                          key={model.id}
                          className={`hs-menu-item hs-model-item ${activeSess.activeModelId === model.id ? "hs-model-selected" : ""}`}
                          onClick={() => {
                            handleSetModel(model.id);
                            setShowModelMenu(false);
                          }}
                        >
                          <span className="hs-model-name">{model.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {activeSess.contextLimit > 0 && (
                <span className="hs-token-pct">{activeSess.contextTokens.toLocaleString()} / {activeSess.contextLimit.toLocaleString()}</span>
              )}
              <button
                className={`hs-send-btn${activeSess.taskRunning ? ' cancel' : ''}`}
                onClick={activeSess.taskRunning ? handleCancelTask : handleSend}
                disabled={!activeSess.connected || (activeSess.taskRunning ? false : (!activeSess.input.trim() && activeSess.staged.length === 0))}
                title={activeSess.taskRunning ? 'Cancel' : 'Send'}
              >
                <svg className="arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="20" x2="12" y2="4"/>
                  <polyline points="6 10 12 4 18 10"/>
                </svg>
                <svg className="stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ─── Render notifications ────────────────────────────────────────────

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

  // ─── Render ─────────────────────────────────────────────────────────

  // No session at all — show minimal header, then loading or error
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
              <button className="win-btn" onClick={() => {
                  getCurrentWindow().toggleMaximize();
                  setIsMaximized((v) => !v);
                }} title={isMaximized ? "Restore" : "Maximize"}>
                {isMaximized ? (
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="4" y="1" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                    <rect x="1" y="4" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                  </svg>
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
              <div className="hs-logo">
                <span>AlayaFace</span>
              </div>
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

  return (
    <div className="app">
      {/* Background orbs */}
      <div className="hs-bg-layer">
        <div className="hs-bg-orb hs-bg-orb-1" />
        <div className="hs-bg-orb hs-bg-orb-2" />
        <div className="hs-bg-orb hs-bg-orb-3" />
      </div>

      {renderNotifications()}

      {/* Header */}
      <header className="app-header" ref={headerRef}>
        <div className="header-top">
        </div>
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
            <div className="window-controls">
              <button className="win-btn" onClick={() => getCurrentWindow().minimize()} title="Minimize">
                <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <button className="win-btn" onClick={() => {
                  getCurrentWindow().toggleMaximize();
                  setIsMaximized((v) => !v);
                }} title={isMaximized ? "Restore" : "Maximize"}>
                {isMaximized ? (
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <rect x="4" y="1" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                    <rect x="1" y="4" width="7" height="7" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                  </svg>
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

      {/* Chat area */}
      <div className={`chat-area ${activeSess.messages.length === 0 ? "chat-area-centered" : ""}`}>
        {activeSess.messages.length > 0 && (
          <>
          <div
            ref={messagesContainerRef}
            className="messages"
          >
            {activeSess.messages.map((msg) => (
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
                      {msg.content.split("\n").length <= 2 && (
                        <span className="reasoning-toggle">▼</span>
                      )}
                      <span className="reasoning-label">Reasoning</span>
                    </div>
                    <div className={`message message-reasoning${msg.content.split("\n").length > 2 && collapsedMsgs.has(msg.id) ? ' reasoning-collapsed' : ''}`}
                         onClick={() => {
                           if (collapsedMsgs.has(msg.id)) {
                             const next = new Set(collapsedMsgs);
                             next.delete(msg.id);
                             setCollapsedMsgs(next);
                           }
                         }}
                    >
                      {(() => {
                        const MAX_LINES = 3;
                        const lines = msg.content.split("\n");
                        if (collapsedMsgs.has(msg.id) && lines.length > MAX_LINES) {
                          // Show only the last MAX_LINES when collapsed
                          const tail = lines.slice(-MAX_LINES);
                          return <>
                            <span className="reasoning-truncated">…</span>
                            {tail.map((line, i) => <span key={i}>{line}{i < tail.length - 1 && <br />}</span>)}
                          </>;
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
                      <div className="message-tool-content">
                        {(() => { const lines = msg.content.split("\n"); return lines.slice(1).join("\n"); })()}
                      </div>
                    )}
                  </div>
                ) : (
                <div
                  key={msg.id}
                  className={`message message-${msg.role}${msg.history_id ? " message-has-ctx" : ""}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    console.log('ctxMenu position:', e.clientX, e.clientY);
                    setCtxMenu({ x: e.clientX, y: e.clientY, message: msg });
                  }}
                >
                  <div className="message-content">
                    {msg.role === "user" ? renderUserContent(msg) : msg.content.split("\n").map((line, i) => <span key={i}>{line}{i < msg.content.split("\n").length - 1 && <br />}</span>)}
                  </div>
                </div>
                )
              ))}
              {/* Blinking cursor when awaiting response */}
              {activeSess.sendPending && (
                <div className="message message-assistant cursor-blink">▊</div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </>
        )}
        {/* Input bar — same element, class toggles centered/bottom */}
        <div className={`session-input-bar${activeSess.messages.length === 0 ? ' session-input-bar-centered' : ''}`}>
          {renderSearchBox()}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div className="ctx-overlay">
          <div
            ref={ctxMenuRef}
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <div className="ctx-menu-item" onClick={() => { handleForkMessage(ctxMenu.message); setCtxMenu(null); }}>
              <span className="ctx-menu-icon">⎆</span>
              <span>Fork up to here</span>
            </div>
          </div>
        </div>
      )}

      {showUrlModal && <UrlModal initialType={typeof showUrlModal === "string" ? showUrlModal : "image"} onClose={() => setShowUrlModal(false)} onConfirm={confirmUrl} />}
    </div>
  );
}

export default App;
