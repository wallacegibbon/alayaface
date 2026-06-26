import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
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
  echoTagToLabel,
} from "./types";
import "./App.css";
import "./components/HomeScreen.css";

// ─── Types ───────────────────────────────────────────────────────────

interface UrlModalProps {
  initialType: string;
  onClose: () => void;
  onConfirm: (url: string, type: string) => void;
}

// ─── Reducer for session state (more efficient than useState spread) ─

type SessionAction =
  | { type: "UPDATE_SESSION"; sessionId: string; updater: (s: SessionState) => SessionState }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "ADD_SESSION"; session: SessionState }
  | { type: "SET_ACTIVE"; sessionId: string | null };

interface SessionReducerState {
  sessions: SessionState[];
  activeId: string | null;
  /** Pending updaters for sessions that haven't been added yet (race from early frames). */
  pendingSessionEvents: Map<string, Array<(s: SessionState) => SessionState>>;
}

function sessionReducer(state: SessionReducerState, action: SessionAction): SessionReducerState {
  switch (action.type) {
    case "UPDATE_SESSION": {
      const exists = state.sessions.some((s) => s.id === action.sessionId);
      if (!exists) {
        // Session not yet registered — buffer the update for later replay
        const pending = new Map(state.pendingSessionEvents);
        const existing = pending.get(action.sessionId) || [];
        pending.set(action.sessionId, [...existing, action.updater]);
        return { ...state, pendingSessionEvents: pending };
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
      // Clean up pending events too
      const pending = new Map(state.pendingSessionEvents);
      pending.delete(action.sessionId);
      return {
        ...state,
        sessions: remaining,
        pendingSessionEvents: pending,
        activeId: state.activeId === action.sessionId
          ? (remaining.length > 0 ? remaining[remaining.length - 1].id : null)
          : state.activeId,
      };
    }
    case "ADD_SESSION": {
      const newSessions = [...state.sessions, action.session];
      const sid = action.session.id;
      // Apply any pending events that arrived before the session was registered
      const pending = new Map(state.pendingSessionEvents);
      const updates = pending.get(sid) || [];
      pending.delete(sid);
      const finalSession = updates.reduce((s, updater) => updater(s), action.session);
      // Replace the last entry (the raw session) with the updated one
      newSessions[newSessions.length - 1] = finalSession;
      return {
        ...state,
        sessions: newSessions,
        pendingSessionEvents: pending,
        activeId: sid,
      };
    }
    case "SET_ACTIVE":
      return { ...state, activeId: action.sessionId };
  }
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
    pendingSessionEvents: new Map(),
  });
  const [showLogs, setShowLogs] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState<string | false>(false);
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const sendingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const uploadTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const uploadDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const notificationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const activeSess = sessions.find((s) => s.id === activeId);

  // ─── Event listeners (once) ─────────────────────────────────────────

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    const setup = async () => {
      // ─── tlv-delta (AT/AR streaming) ────────────────────────────────
      const un1 = await listen<DeltaEvent>("tlv-delta", (ev) => {
        const { session_id, history_id, content, tag } = ev.payload;
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
          return { ...s, historyContents: newHistoryContents, messages: newMsgs };
        }});
      });
      if (cancelled) { un1(); return; }
      unlisteners.push(un1);

      // ─── tlv-frame (all other frames) ───────────────────────────────
      const un2 = await listen<FrameEvent>("tlv-frame", (ev) => {
        const { session_id, tag, json, history_id, content } = ev.payload;

        dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => {
          // ── Handle user echo frames (UT/UI/UV/UA/UD on stdout) ──────
          if (isUserEchoTag(tag)) {
            const mediaType = echoTagToMediaType(tag);
            const textContent = tag === "UT" ? (content || "") : "";
            const label = echoTagToLabel(tag);

            // Build media item for non-text echoes
            const mediaItem: MediaItem | null = mediaType && content
              ? { media_type: mediaType, uri: content }
              : null;

            // If this is the first user echo after a non-user frame (or initial),
            // start a new pending user message
            const newParts = [...s.pendingUserParts];

            // Check if we already have a pending user message (consecutive user echoes)
            // If no pending parts and we have messages, the last message might be a user message
            // that we should append to
            if (newParts.length === 0 && s.messages.length > 0) {
              const lastMsg = s.messages[s.messages.length - 1];
              if (lastMsg.role === "user" && lastMsg.history_id === history_id) {
                // Same user message — update in place
                const newMsgs = [...s.messages];
                if (tag === "UT") {
                  newMsgs[newMsgs.length - 1] = {
                    ...lastMsg,
                    content: textContent,
                    history_id: history_id || undefined,
                  };
                } else if (mediaItem) {
                  const existingMedia = lastMsg.media || [];
                  newMsgs[newMsgs.length - 1] = {
                    ...lastMsg,
                    media: [...existingMedia, mediaItem],
                    history_id: history_id || undefined,
                  };
                }
                return { ...s, messages: newMsgs, sendPending: false };
              }
            }

            // Accumulate into pending parts
            newParts.push({
              id: `userpart-${history_id || Date.now()}`,
              historyId: history_id || "",
              tag,
              content: textContent || label,
              media_type: mediaType || undefined,
            });

            return { ...s, pendingUserParts: newParts, sendPending: false };
          }

          // ── Non-user tag: flush any pending user content ─────────────
          let newS = s;
          if (newS.pendingUserParts.length > 0) {
            const parts = newS.pendingUserParts;
            const textParts = parts.filter((p) => p.tag === "UT").map((p) => p.content).join("\n");
            const mediaParts: MediaItem[] = parts
              .filter((p) => p.media_type)
              .map((p) => ({ media_type: p.media_type!, uri: p.content }));

            const userMsg: Message = {
              id: `user-echo-${Date.now()}`,
              role: "user",
              content: textParts || (mediaParts.length > 0 ? "(media message)" : ""),
              media: mediaParts.length > 0 ? mediaParts : undefined,
              history_id: parts[0]?.historyId || undefined,
            };
            newS = { ...newS, messages: [...newS.messages, userMsg], pendingUserParts: [] };
          }

          // ── SM: system messages ──────────────────────────────────────
          if (tag === "SM" && json) {
            const sm = json as { type?: string; data?: Record<string, unknown> };
            const d = sm.data || {};
            switch (sm.type) {
              case "task": {
                const td = d as Record<string, unknown>;
                const tokens = (td.context ?? td.tokens ?? td.context_tokens ?? td.usage) as number | undefined;
                return { ...newS, taskRunning: (td.in_progress as boolean) ?? false, contextTokens: tokens ?? newS.contextTokens, statusMsg: td.in_progress ? "Task in progress…" : "Task complete" };
              }
              case "error": {
                const ed = d as { text?: string };
                const errId = `err-${Date.now()}`;
                return { ...newS, notifications: [...newS.notifications, { id: errId, type: "error", text: ed.text || "Unknown error", timestamp: Date.now() }] };
              }
              case "notify": {
                const nd = d as { text?: string };
                const notId = `notify-${Date.now()}`;
                return { ...newS, notifications: [...newS.notifications, { id: notId, type: "notify", text: nd.text || "", timestamp: Date.now() }] };
              }
              case "model_list": {
                const ml = d as { models?: { id?: number; name?: string }[] };
                if (ml.models) return { ...newS, models: ml.models.filter((m) => m.id !== undefined && m.name).map((m) => ({ id: m.id!, name: m.name! })) };
                return newS;
              }
              case "model": {
                const md = d as Record<string, unknown>;
                const tokens = (md.context_tokens ?? md.context ?? md.tokens) as number | undefined;
                return { ...newS, activeModelId: (md.active_id as number) ?? newS.activeModelId, activeModelName: (md.active_name as string) ?? newS.activeModelName, contextLimit: (md.context_limit as number) ?? newS.contextLimit, contextTokens: tokens ?? newS.contextTokens };
              }
              case "tool_confirm": {
                const cd = d as { id?: string };
                return { ...newS, messages: [...newS.messages, { id: `confirm-${Date.now()}`, role: "system" as const, content: `🔧 Tool confirmation: ${cd.id}` }] };
              }
            }
          }

          // ── AF: tool call frames ─────────────────────────────────────
          if (tag === "AF" && json) {
            const td = json as { id?: string; name?: string; input?: Record<string, unknown> };
            const toolId = td.id || "";
            const newToolCalls = new Map(newS.toolCalls);
            const newMsgs = [...newS.messages];
            if (td.name) {
              newToolCalls.set(toolId, { id: toolId, name: td.name, started: true, input_received: false });
              newMsgs.push({ id: `tool-${toolId}`, role: "tool" as const, content: `🔧 **${td.name}**`, tool_id: toolId, tool_name: td.name, history_id: history_id || undefined });
            } else if (td.input) {
              const tc = newToolCalls.get(toolId);
              if (tc) { tc.input = td.input; tc.input_received = true; }
              const idx = newMsgs.findIndex((m) => m.tool_id === toolId);
              if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: `🔧 **${newMsgs[idx].tool_name || "Tool"}**\n\`\`\`json\n${JSON.stringify(td.input, null, 2)}\n\`\`\`` };
            }
            return { ...newS, toolCalls: newToolCalls, messages: newMsgs };
          }

          // ── UF: tool result frames ──────────────────────────────────
          if (tag === "UF" && json) {
            const rd = json as { id?: string; is_error?: boolean; output?: unknown };
            const toolId = rd.id || "";
            const isError = rd.is_error || false;
            let outStr = "";
            if (rd.output) {
              if (Array.isArray(rd.output)) outStr = rd.output.map((i: Record<string, unknown>) => i.text || i.uri || JSON.stringify(i)).join("\n");
              else outStr = JSON.stringify(rd.output, null, 2);
            }
            if (outStr.length > 500) outStr = outStr.slice(0, 500) + "\n… (truncated)";
            const tc = newS.toolCalls.get(toolId);
            const toolName = tc?.name || "Tool";
            const newMsgs = [...newS.messages];
            const idx = newMsgs.findIndex((m) => m.tool_id === toolId);
            if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: isError ? `❌ **${toolName}** (error)\n\`\`\`\n${outStr}\n\`\`\`` : `✅ **${toolName}**\n\`\`\`\n${outStr}\n\`\`\``, is_error: isError, history_id: history_id || newMsgs[idx].history_id };
            return { ...newS, messages: newMsgs };
          }

          return newS;
        }});
      });
      if (cancelled) { un2(); return; }
      unlisteners.push(un2);

      // ─── core-status ────────────────────────────────────────────────
      const un3 = await listen<StatusEvent>("core-status", (ev) => {
        const { session_id, connected, message } = ev.payload;
        dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => ({
          ...s, connected, statusMsg: message,
        })});
      });
      if (cancelled) { un3(); return; }
      unlisteners.push(un3);
    };

    setup();
    return () => { cancelled = true; unlisteners.forEach((fn) => { try { fn(); } catch { /* */ } }); };
  }, []);

  // ─── Auto-create initial session ─────────────────────────────────────
  // Uses cancelled flag to handle React 18 StrictMode double-fire.
  // No createdRef guard — that would break HMR (refs persist across hot reloads).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await invoke<string>("create_session", { binaryPath: "", configPath: "" });
        if (!cancelled) {
          const newSess = createSessionState(id);
          dispatch({ type: "ADD_SESSION", session: newSess });
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
    return () => { cancelled = true; };
  }, []);

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
      if (ctxMenu) {
        if (ctxMenuRef.current && !ctxMenuRef.current.contains(event.target as Node)) {
          setCtxMenu(null);
        }
        return;
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
    if (!activeSess || activeSess.notifications.length === 0) return;

    const timers = notificationTimersRef.current;

    // Clear all previous timers
    timers.forEach((t) => clearTimeout(t));
    timers.clear();

    // Set new timers for each notification
    const now = Date.now();
    for (const n of activeSess.notifications) {
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

    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
    // Only run when notifications array reference changes (new items added)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSess?.notifications.length, activeSess?.id]);

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

  // ─── Send / Cancel / Clear ──────────────────────────────────────────

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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
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

  const handleClear = useCallback(() => {
    if (!activeId) return;
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: () => createSessionState(activeId) });
  }, [activeId]);

  const handleSaveSession = useCallback(async () => {
    if (!activeId) return;
    const name = prompt("Save session as:", `session-${Date.now()}.md`);
    if (!name) return;
    try {
      await invoke("alayacore_save", { sessionId: activeId, filename: name });
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Saving to ${name}…` }) });
    } catch (err) {
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Save error: ${err}` }) });
    }
  }, [activeId]);

  const handleForkMessage = useCallback(async (msg: Message) => {
    const hid = msg.history_id;
    if (!hid || !activeId) return;
    const name = prompt(`Fork up to history ID ${hid}, save as:`, `fork-${Date.now()}.md`);
    if (!name) return;
    try {
      await invoke("alayacore_fork", { sessionId: activeId, historyId: hid, filename: name });
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, statusMsg: `Forked to ${name}` }) });
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
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        input.onchange = null;
        try {
          const uri = await fileToDataUri(file);
          if (!activeId) return;
          const newItem: StagedMedia = { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri, name: file.name };
          dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: [...s.staged, newItem] }) });
        } catch { /* */ }
      }
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    document.body.appendChild(input);
    input.click();
  }, [activeId]);

  const handleModelClick = useCallback(() => {
    setShowModelMenu((prev) => !prev);
  }, []);

  const fetchStderr = useCallback(async () => {
    if (!activeId) return;
    try {
      const lines = await invoke<string[]>("get_stderr_log", { sessionId: activeId });
      dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, stderrLines: lines }) });
    } catch { /* */ }
  }, [activeId]);

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
          <input
            ref={inputRef}
            type="text"
            className="hs-search-input"
            placeholder={activeSess.staged.length > 0 ? "Add a message…" : "Type a message…"}
            value={activeSess.input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeSess.connected}
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
              <button type="button" className="hs-control-button" title="Voice input">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                  <line x1="12" y1="19" x2="12" y2="23"/>
                  <line x1="8" y1="23" x2="16" y2="23"/>
                </svg>
              </button>
              <button type="button" className="hs-control-button hs-audio-button" title="Send">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 22 12 5 21 5 3" transform="rotate(90, 13.5, 12)"/>
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
        <header className="app-header">
          <div className="header-top">
            <h1>AlayaFace</h1>
            <div className="connection-controls">
              <button onClick={handleCreateSession} className="connect-btn">+ New Session</button>
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
      <header className="app-header">
        <div className="header-top">
          <h1>AlayaFace</h1>
          <div className="connection-controls">
            <button onClick={handleCreateSession} className="connect-btn">+ New Session</button>
            <button onClick={handleSaveSession} disabled={activeSess.messages.length === 0} className="save-btn" title="Save session to file">Save</button>
            <button onClick={() => { setShowLogs(!showLogs); if (!showLogs) fetchStderr(); }} className="log-btn">Logs</button>
          </div>
        </div>

        {/* Tab bar */}
        {sessions.length > 0 && (
          <div className="tab-bar">
            {sessions.map((s, i) => (
              <div key={s.id} className={`tab ${s.id === activeId ? "tab-active" : ""} ${!s.connected ? "tab-disconnected" : ""}`} onClick={() => switchSession(s.id)}>
                <span className="tab-dot" />
                <span className="tab-label">Session {i + 1}</span>
                <button className="tab-close" onClick={(e) => { e.stopPropagation(); handleCloseSession(s.id); }} title="Close session">✕</button>
              </div>
            ))}
          </div>
        )}

        {activeSess && (
          <div className={`status ${activeSess.connected ? "connected" : "disconnected"}`}>{activeSess.statusMsg}</div>
        )}
      </header>

      {/* Chat area */}
      <div className={`chat-area ${activeSess.messages.length === 0 ? "chat-area-centered" : ""}`}>
        {activeSess.messages.length === 0 ? (
          /* ─── Empty state: just the input box ─── */
          <div className="hs-container-inline">
            {renderSearchBox()}
          </div>
        ) : (
          /* ─── Messages + Input ─── */
          <>
            <div
              ref={messagesContainerRef}
              className="messages"
            >
              {activeSess.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`message message-${msg.role}${msg.history_id ? " message-has-ctx" : ""}`}
                  onContextMenu={(e) => {
                    if (msg.history_id) {
                      e.preventDefault();
                      setCtxMenu({ x: e.clientX, y: e.clientY, message: msg });
                    }
                  }}
                >
                  <div className="message-header">
                    {msg.role === "user" && "🧑 You"}
                    {msg.role === "assistant" && "🤖 Assistant"}
                    {msg.role === "reasoning" && "🧠 Reasoning"}
                    {msg.role === "tool" && "🛠 Tool"}
                    {msg.role === "system" && "ℹ System"}
                  </div>
                  <div className="message-content">
                    {msg.role === "user" ? renderUserContent(msg) : msg.content.split("\n").map((line, i) => <span key={i}>{line}{i < msg.content.split("\n").length - 1 && <br />}</span>)}
                  </div>
                </div>
              ))}
              {/* Blinking cursor when awaiting response or processing */}
              {(activeSess.sendPending || Array.from(activeSess.historyContents.entries()).length > 0) && (
                <div className="message message-assistant cursor-blink">▊</div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area styled as HomeScreen search box */}
            <div className="session-input-bar">
              {renderSearchBox()}
              <div className="session-input-actions">
                <button onClick={handleSend} disabled={!activeSess.connected || activeSess.taskRunning || (!activeSess.input.trim() && activeSess.staged.length === 0)} className="send-btn">Send</button>
                <button onClick={handleCancelTask} disabled={!activeSess.taskRunning} className="cancel-btn">Cancel</button>
                <button onClick={handleClear} disabled={activeSess.messages.length === 0 && activeSess.staged.length === 0} className="clear-btn">Clear</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <div
            className="ctx-menu-item"
            onClick={() => {
              handleForkMessage(ctxMenu.message);
              setCtxMenu(null);
            }}
          >
            <span className="ctx-menu-icon">⎆</span>
            <span>Fork up to here</span>
          </div>
        </div>
      )}

      {/* Log panel */}
      {showLogs && activeSess && (
        <div className="log-panel">
          <div className="log-header">
            <span>Stderr — Session {sessions.indexOf(activeSess) + 1}</span>
            <button onClick={fetchStderr} className="refresh-btn">Refresh</button>
          </div>
          <pre className="log-content">{activeSess.stderrLines.length === 0 ? "(no output)" : activeSess.stderrLines.join("\n")}</pre>
        </div>
      )}

      {showUrlModal && <UrlModal initialType={typeof showUrlModal === "string" ? showUrlModal : "image"} onClose={() => setShowUrlModal(false)} onConfirm={confirmUrl} />}
    </div>
  );
}

export default App;
