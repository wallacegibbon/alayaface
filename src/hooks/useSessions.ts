import { useEffect, useRef, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  type DeltaEvent,
  type FrameEvent,
  type StatusEvent,
  type MediaItem,
  type Message,
  type SessionState,
  createSessionState,
  isUserEchoTag,
  echoTagToMediaType,
} from "../types";

// ─── Reducer Types ───────────────────────────────────────────────────

export type SessionAction =
  | { type: "UPDATE_SESSION"; sessionId: string; updater: (s: SessionState) => SessionState }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "ADD_SESSION"; session: SessionState }
  | { type: "SET_ACTIVE"; sessionId: string | null };

interface SessionReducerState {
  sessions: SessionState[];
  activeId: string | null;
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

// ─── Event Handler Factory ───────────────────────────────────────────

export function createEventHandlers(dispatch: React.Dispatch<SessionAction>) {
  const handleDeltaEvent = (ev: DeltaEvent) => {
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
      return { ...s, historyContents: newHistoryContents, messages: newMsgs, sendPending: false };
    }});
  };

  const handleUserEchoFrame = (s: SessionState, tag: string, history_id: string | null, content: string | null): SessionState => {
    const mediaType = echoTagToMediaType(tag);
    const textContent = tag === "UT" ? (content || "") : "";

    if (history_id && s.processedEchoIds.has(history_id)) return s;

    const newEchoIds = history_id ? new Set(s.processedEchoIds).add(history_id) : s.processedEchoIds;
    const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null;
    const sameTurn = lastMsg?.role === "user" && !history_id ? false : lastMsg?.role === "user";

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

    const newMsg: Message = {
      id: `user-${history_id || Date.now()}`,
      role: "user",
      content: textContent,
      media: mediaType && content ? [{ media_type: mediaType, uri: content }] : undefined,
      history_id: history_id || undefined,
    };
    return { ...s, messages: [...s.messages, newMsg], processedEchoIds: newEchoIds, sendPending: false };
  };

  const handleSystemMsg = (s: SessionState, sm: { type?: string; data?: Record<string, unknown> }): SessionState => {
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
  };

  const handleToolCallFrame = (s: SessionState, json: Record<string, unknown>, history_id: string | null): SessionState => {
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
  };

  const handleToolResultFrame = (s: SessionState, json: Record<string, unknown>, history_id: string | null): SessionState => {
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
  };

  const handleFrameEvent = (ev: FrameEvent) => {
    const { session_id, tag, json, history_id, content } = ev;
    dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => {
      if (isUserEchoTag(tag)) return handleUserEchoFrame(s, tag, history_id, content);
      let newS = s;
      if (tag === "SM" && json) return handleSystemMsg(newS, json as { type?: string; data?: Record<string, unknown> });
      if (tag === "AF" && json) return handleToolCallFrame(newS, json, history_id);
      if (tag === "UF" && json) return handleToolResultFrame(newS, json, history_id);
      return newS;
    }});
  };

  const handleStatusEvent = (ev: StatusEvent) => {
    const { session_id, connected, message } = ev;
    dispatch({ type: "UPDATE_SESSION", sessionId: session_id, updater: (s) => ({
      ...s, connected, statusMsg: message,
    })});
  };

  return { handleDeltaEvent, handleFrameEvent, handleStatusEvent };
}

// ─── UseSessions Hook ────────────────────────────────────────────────

export interface UseSessionsReturn {
  sessions: SessionState[];
  activeId: string | null;
  activeSess: SessionState | undefined;
  dispatch: React.Dispatch<SessionAction>;
  initializing: boolean;
  initError: string | null;
  handleCreateSession: () => Promise<void>;
  handleCloseSession: (id: string) => Promise<void>;
  switchSession: (id: string) => void;
  setInput: (val: string) => void;
  confirmUrl: (url: string, type: string) => void;
  removeStaged: (id: string) => void;
}

export function useSessions(): UseSessionsReturn {
  const [{ sessions, activeId }, dispatch] = useReducer(sessionReducer, {
    sessions: [],
    activeId: null,
    pendingUpdates: new Map(),
  });
  const [initializing, setInitializing] = useReducer((_: boolean) => false, true);
  const [initError, setInitError] = useReducer((_: string | null, err: string | null) => err, null);
  const handlersRef = useRef<ReturnType<typeof createEventHandlers> | null>(null);
  if (!handlersRef.current) handlersRef.current = createEventHandlers(dispatch);

  const activeSess = sessions.find((s) => s.id === activeId);

  // Event listeners + initial session creation
  useEffect(() => {
    let cancelled = false;
    let createdSessionId: string | null = null;
    const unlisteners: UnlistenFn[] = [];
    const handlers = handlersRef.current!;

    (async () => {
      const un1 = await listen<DeltaEvent>("tlv-delta", (ev) => handlers.handleDeltaEvent(ev.payload));
      if (cancelled) { un1(); return; }
      unlisteners.push(un1);

      const un2 = await listen<FrameEvent>("tlv-frame", (ev) => handlers.handleFrameEvent(ev.payload));
      if (cancelled) { un2(); return; }
      unlisteners.push(un2);

      const un3 = await listen<StatusEvent>("core-status", (ev) => handlers.handleStatusEvent(ev.payload));
      if (cancelled) { un3(); return; }
      unlisteners.push(un3);

      try {
        const id = await invoke<string>("create_session", { binaryPath: "", configPath: "" });
        createdSessionId = id;
        if (!cancelled) {
          dispatch({ type: "ADD_SESSION", session: createSessionState(id) });
        } else {
          try { await invoke("close_session", { sessionId: id }); } catch { /* */ }
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to auto-create session:", err);
          setInitError(String(err));
        }
      } finally {
        if (!cancelled) setInitializing();
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => { try { fn(); } catch { /* */ } });
      if (createdSessionId !== null) {
        invoke("close_session", { sessionId: createdSessionId }).catch(() => {});
      }
    };
  }, []);

  const handleCreateSession = async () => {
    try {
      const id = await invoke<string>("create_session", { binaryPath: "", configPath: "" });
      dispatch({ type: "ADD_SESSION", session: createSessionState(id) });
    } catch (err) {
      console.error("Failed to create session:", err);
      setInitError(String(err));
    }
  };

  const handleCloseSession = async (id: string) => {
    try { await invoke("close_session", { sessionId: id }); } catch { /* */ }
    dispatch({ type: "REMOVE_SESSION", sessionId: id });
  };

  const switchSession = (id: string) => {
    dispatch({ type: "SET_ACTIVE", sessionId: id });
  };

  const setInput = (val: string) => {
    if (!activeId) return;
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, input: val }) });
  };

  const confirmUrl = (url: string, type: string) => {
    if (!activeId) return;
    const newItem: MediaItem & { id: string } = { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri: url, name: url };
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: [...s.staged, newItem] }) });
  };

  const removeStaged = (id: string) => {
    if (!activeId) return;
    dispatch({ type: "UPDATE_SESSION", sessionId: activeId, updater: (s) => ({ ...s, staged: s.staged.filter((m) => m.id !== id) }) });
  };

  return {
    sessions, activeId, activeSess, dispatch, initializing, initError,
    handleCreateSession, handleCloseSession, switchSession, setInput, confirmUrl, removeStaged,
  };
}
