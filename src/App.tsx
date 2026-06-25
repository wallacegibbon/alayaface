import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import "./components/HomeScreen.css";

// ─── Types ───────────────────────────────────────────────────────────

interface DeltaEvent {
  session_id: string;
  stream_id: string;
  content: string;
  tag: "AT" | "AR";
}

interface FrameEvent {
  session_id: string;
  tag: string;
  raw_value: string;
  stream_id: string | null;
  content: string | null;
  json: Record<string, unknown> | null;
}

interface StatusEvent {
  session_id: string;
  connected: boolean;
  message: string;
}

interface MediaItem {
  media_type: "image" | "audio" | "video" | "document";
  uri: string;
  name?: string;
}

interface StagedMedia extends MediaItem {
  id: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "reasoning";
  content: string;
  tool_id?: string;
  tool_name?: string;
  is_error?: boolean;
  stream_id?: string;
  media?: MediaItem[];
}

interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
  started: boolean;
  input_received: boolean;
}

interface NotificationItem {
  id: string;
  type: "notify" | "error";
  text: string;
  timestamp: number;
}

interface SessionState {
  id: string;
  connected: boolean;
  statusMsg: string;
  messages: Message[];
  staged: StagedMedia[];
  models: { id: number; name: string }[];
  activeModelId: number | null;
  activeModelName: string;
  taskRunning: boolean;
  contextTokens: number;
  contextLimit: number;
  streamContents: Map<string, string>;
  streamRoles: Map<string, "assistant" | "reasoning">;
  toolCalls: Map<string, ToolCall>;
  stderrLines: string[];
  notifications: NotificationItem[];
  input: string;
}

// ─── Media helpers ───────────────────────────────────────────────────

const MEDIA_ACCEPT: Record<string, string> = {
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
  document: ".pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml,.html,.css,.js,.ts,.rs,.py,.go,.java,.c,.cpp,.h,.hpp",
};

const MEDIA_ICON: Record<string, string> = {
  image: "🖼", audio: "🎵", video: "🎬", document: "📄",
};

// ─── Upload items for attach dropdown ─────────────────────────────────

const uploadItems = [
  { icon: "🖼", label: "Image", accept: MEDIA_ACCEPT.image, type: "image" as const },
  { icon: "🎵", label: "Audio", accept: MEDIA_ACCEPT.audio, type: "audio" as const },
  { icon: "🎬", label: "Video", accept: MEDIA_ACCEPT.video, type: "video" as const },
  { icon: "📄", label: "Document", accept: MEDIA_ACCEPT.document, type: "document" as const },
  { icon: "🔗", label: "From URL", accept: "", type: "url" as const },
];

function shortName(uri: string, name?: string): string {
  if (name) return name;
  if (uri.startsWith("data:")) {
    const mime = uri.split(";")[0]?.replace("data:", "") || "file";
    return `[${mime}]`;
  }
  try { const u = new URL(uri); const parts = u.pathname.split("/").filter(Boolean); return parts.pop() || uri; }
  catch { return uri.length > 40 ? uri.slice(0, 40) + "…" : uri; }
}

// ─── URL Modal ───────────────────────────────────────────────────────

function UrlModal({ initialType, onClose, onConfirm }: { initialType: string; onClose: () => void; onConfirm: (url: string, type: string) => void }) {
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

// ─── Helpers ─────────────────────────────────────────────────────────

function createSessionState(id: string): SessionState {
  return {
    id,
    connected: true,
    statusMsg: "Connected",
    messages: [],
    staged: [],
    models: [],
    activeModelId: null,
    activeModelName: "",
    taskRunning: false,
    contextTokens: 0,
    contextLimit: 0,
    streamContents: new Map(),
    streamRoles: new Map(),
    toolCalls: new Map(),
    stderrLines: [],
    notifications: [],
    input: "",
  };
}

// ─── MIME type normalization ──────────────────────────────────────────

const MIME_ALIAS: Record<string, string> = {
  "audio/vnd.wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/x-mpeg": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/x-m4a": "audio/mp4",
  "video/x-msvideo": "video/avi",
  "video/x-matroska": "video/mkv",
  "image/jpg": "image/jpeg",
  "image/x-png": "image/png",
  "image/x-ms-bmp": "image/bmp",
  "image/x-icon": "image/vnd.microsoft.icon",
  "application/x-javascript": "text/javascript",
  "text/x-typescript": "text/typescript",
};

function normalizeMime(mime: string, fileName: string): string {
  // Check known aliases
  const lower = mime.toLowerCase();
  if (MIME_ALIAS[lower]) return MIME_ALIAS[lower];
  // If it's an obscure vendor type like audio/vnd.*, try falling back to extension-based type
  if (lower.includes("/vnd.")) {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext === "wav") return "audio/wav";
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "mp4") return "video/mp4";
    if (ext === "webm") return "video/webm";
    if (ext === "ogg" || ext === "oga") return "audio/ogg";
    if (ext === "ogv") return "video/ogg";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "png") return "image/png";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
  }
  return mime;
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
      // Fix MIME type if browser used a non-standard one
      const comma = dataUri.indexOf(",");
      const header = dataUri.slice(0, comma);
      const rawMime = header.replace("data:", "");
      const normalized = normalizeMime(rawMime, file.name);
      if (normalized !== rawMime) {
        resolve(`data:${normalized};base64,${dataUri.slice(comma + 1)}`);
      } else {
        resolve(dataUri);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Component ───────────────────────────────────────────────────────

function App() {
  // Session management
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [binaryPath, setBinaryPath] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState<string | false>(false);
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const sendingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const uploadTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const uploadDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const activeSess = sessions.find((s) => s.id === activeId);

  // ─── Event listeners (once) ─────────────────────────────────────────

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    const setup = async () => {
      const un1 = await listen<DeltaEvent>("tlv-delta", (ev) => {
        const { session_id, stream_id, content, tag } = ev.payload;
        const role = tag === "AT" ? "assistant" : "reasoning";
        setSessions((prev) => prev.map((s) => {
          if (s.id !== session_id) return s;
          const existing = s.streamContents.get(stream_id);
          const newStreamContents = new Map(s.streamContents);
          const newMsgs = [...s.messages];

          if (existing !== undefined) {
            newStreamContents.set(stream_id, existing + content);
            const idx = newMsgs.findIndex((m) => m.stream_id === stream_id && m.role === role);
            if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: existing + content };
          } else {
            newStreamContents.set(stream_id, content);
            newMsgs.push({ id: `stream-${stream_id}-${Date.now()}`, role, content, stream_id });
          }
          return { ...s, streamContents: newStreamContents, messages: newMsgs };
        }));
      });
      if (cancelled) { un1(); return; }
      unlisteners.push(un1);

      const un2 = await listen<FrameEvent>("tlv-frame", (ev) => {
        const { session_id, tag, json } = ev.payload;
        setSessions((prev) => prev.map((s) => {
          if (s.id !== session_id) return s;

          if (tag === "PROMPT" && json) {
            const pd = json as { text?: string; media?: MediaItem[] };
            const media = pd.media || [];
            const text = pd.text || "";
            return { ...s, messages: [...s.messages, { id: `prompt-${Date.now()}`, role: "user" as const, content: text || "(media message)", media }] };
          }

          if (tag === "SM" && json) {
            const sm = json as { type?: string; data?: Record<string, unknown> };
            const d = sm.data || {};
            switch (sm.type) {
              case "task": {
                const td = d as Record<string, unknown>;
                const tokens = (td.context ?? td.tokens ?? td.context_tokens ?? td.usage) as number | undefined;
                return { ...s, taskRunning: (td.in_progress as boolean) ?? false, contextTokens: tokens ?? s.contextTokens, statusMsg: td.in_progress ? "Task in progress…" : "Task complete" };
              }
              case "error": {
                const ed = d as { text?: string };
                const errId = `err-${Date.now()}`;
                return { ...s, notifications: [...s.notifications, { id: errId, type: "error", text: ed.text || "Unknown error", timestamp: Date.now() }] };
              }
              case "notify": {
                const nd = d as { text?: string };
                const notId = `notify-${Date.now()}`;
                return { ...s, notifications: [...s.notifications, { id: notId, type: "notify", text: nd.text || "", timestamp: Date.now() }] };
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
          }

          if (tag === "AF" && json) {
            const td = json as { id?: string; name?: string; input?: Record<string, unknown> };
            const toolId = td.id || "";
            const newToolCalls = new Map(s.toolCalls);
            const newMsgs = [...s.messages];
            if (td.name) {
              newToolCalls.set(toolId, { id: toolId, name: td.name, started: true, input_received: false });
              newMsgs.push({ id: `tool-${toolId}`, role: "tool" as const, content: `🔧 **${td.name}**`, tool_id: toolId, tool_name: td.name });
            } else if (td.input) {
              const tc = newToolCalls.get(toolId);
              if (tc) { tc.input = td.input; tc.input_received = true; }
              const idx = newMsgs.findIndex((m) => m.tool_id === toolId);
              if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: `🔧 **${newMsgs[idx].tool_name || "Tool"}**\n\`\`\`json\n${JSON.stringify(td.input, null, 2)}\n\`\`\`` };
            }
            return { ...s, toolCalls: newToolCalls, messages: newMsgs };
          }

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
            const tc = s.toolCalls.get(toolId);
            const toolName = tc?.name || "Tool";
            const newMsgs = [...s.messages];
            const idx = newMsgs.findIndex((m) => m.tool_id === toolId);
            if (idx >= 0) newMsgs[idx] = { ...newMsgs[idx], content: isError ? `❌ **${toolName}** (error)\n\`\`\`\n${outStr}\n\`\`\`` : `✅ **${toolName}**\n\`\`\`\n${outStr}\n\`\`\``, is_error: isError };
            return { ...s, messages: newMsgs };
          }

          return s;
        }));
      });
      if (cancelled) { un2(); return; }
      unlisteners.push(un2);

      const un3 = await listen<StatusEvent>("core-status", (ev) => {
        const { session_id, connected, message } = ev.payload;
        setSessions((prev) => prev.map((s) => s.id === session_id ? { ...s, connected, statusMsg: message } : s));
      });
      if (cancelled) { un3(); return; }
      unlisteners.push(un3);
    };

    setup();
    return () => { cancelled = true; unlisteners.forEach((fn) => { try { fn(); } catch { /* */ } }); };
  }, []);

  // Scroll to bottom
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [activeSess?.messages]);

  // ─── Close dropdowns on outside click ────────────────────────────────

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(event.target as Node)) {
        setShowUploadMenu(false);
      }
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setShowModelMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ─── Auto-dismiss notifications ──────────────────────────────────────

  useEffect(() => {
    if (!activeSess || activeSess.notifications.length === 0) return;
    const now = Date.now();
    const timers = activeSess.notifications.map((n) => {
      const elapsed = now - n.timestamp;
      const remaining = Math.max(0, 4000 - elapsed);
      return setTimeout(() => {
        setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, notifications: s.notifications.filter((nn) => nn.id !== n.id) } : s));
      }, remaining);
    });
    return () => timers.forEach(clearTimeout);
  }, [activeSess?.notifications, activeId]);

  // ─── Session lifecycle ──────────────────────────────────────────────

  const handleCreateSession = useCallback(async () => {
    try {
      const id = await invoke<string>("create_session", { binaryPath });
      const newSess = createSessionState(id);
      setSessions((prev) => [...prev, newSess]);
      setActiveId(id);
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [binaryPath]);

  const handleCloseSession = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { sessionId: id });
    } catch { /* */ }
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
      return remaining;
    });
  }, [activeId]);

  const switchSession = useCallback((id: string) => {
    setActiveId(id);
    setShowUrlModal(false);
  }, []);

  // ─── Input handling ─────────────────────────────────────────────────

  const setInput = useCallback((val: string) => {
    setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, input: val } : s));
  }, [activeId]);

  const setStaged = useCallback((fn: StagedMedia[] | ((prev: StagedMedia[]) => StagedMedia[])) => {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== activeId) return s;
      const newStaged = typeof fn === "function" ? (fn as (prev: StagedMedia[]) => StagedMedia[])(s.staged) : fn;
      return { ...s, staged: newStaged };
    }));
  }, [activeId]);

  const confirmUrl = useCallback((url: string, type: string) => {
    setStaged((prev: StagedMedia[]) => [...prev, { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri: url, name: url }]);
    setShowUrlModal(false);
  }, [setStaged]);

  const removeStaged = useCallback((id: string) => {
    setStaged((prev: StagedMedia[]) => prev.filter((m) => m.id !== id));
  }, [setStaged]);

  // ─── Send / Cancel / Clear ──────────────────────────────────────────

  const handleSend = useCallback(async () => {
    if (sendingRef.current || !activeSess) return;
    if (activeSess.taskRunning) return;
    const text = activeSess.input.trim();
    if ((!text && activeSess.staged.length === 0) || !activeSess.connected) return;
    sendingRef.current = true;

    const mediaItems: MediaItem[] = activeSess.staged.map((s) => ({ media_type: s.media_type, uri: s.uri, name: s.name }));

    setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, input: "", staged: [], statusMsg: "Sending…" } : s));

    try {
      await invoke("send_prompt", { sessionId: activeId, text, media: mediaItems });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: "Waiting for response…" } : s));
    } catch (err) {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Send error: ${err}`, messages: [...s.messages, { id: `err-${Date.now()}`, role: "system" as const, content: `⚠ Send error: ${err}` }] } : s));
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
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: "Cancelling…" } : s));
      await invoke("cancel_task", { sessionId: activeId });
    } catch (err) {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Cancel error: ${err}` } : s));
    }
  }, [activeId]);

  const handleClear = useCallback(() => {
    if (!activeId) return;
    setSessions((prev) => prev.map((s) => s.id === activeId ? {
      ...s, messages: [], staged: [], streamContents: new Map(), streamRoles: new Map(), toolCalls: new Map(),
    } : s));
  }, [activeId]);

  const handleSaveSession = useCallback(async () => {
    if (!activeId) return;
    const name = prompt("Save session as:", `session-${Date.now()}.md`);
    if (!name) return;
    try {
      await invoke("save_session", { sessionId: activeId, filename: name });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Saving to ${name}…` } : s));
    } catch (err) {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Save error: ${err}` } : s));
    }
  }, [activeId]);

  const handleForkSession = useCallback(async () => {
    if (!activeId) return;
    const historyId = prompt("Fork up to history ID (number):");
    if (!historyId) return;
    const name = prompt("Fork to filename:", `fork-${Date.now()}.md`);
    if (!name) return;
    try {
      await invoke("fork_session", { sessionId: activeId, historyId: historyId.trim(), filename: name });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Forking to ${name}…` } : s));
    } catch (err) {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Fork error: ${err}` } : s));
    }
  }, [activeId]);

  const handleSetModel = useCallback(async (modelId: number) => {
    if (!activeId) return;
    try {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: "Switching model…" } : s));
      await invoke("set_model", { sessionId: activeId, modelId });
    } catch (err) {
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, statusMsg: `Model switch failed: ${err}` } : s));
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
        input.onchange = null; // prevent double-fire
        try {
          const uri = await fileToDataUri(file);
          setStaged((prev) => [...prev, { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri, name: file.name }]);
        } catch { /* file read failed silently */ }
      }
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    document.body.appendChild(input);
    input.click();
  }, [setStaged]);

  const handleModelClick = useCallback(() => {
    setShowModelMenu((prev) => !prev);
  }, []);

  const fetchStderr = useCallback(async () => {
    if (!activeId) return;
    try {
      const lines = await invoke<string[]>("get_stderr_log", { sessionId: activeId });
      setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, stderrLines: lines } : s));
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
      out.push(<div key="text" className="message-text">{msg.content.split("\n").map((line, i) => <span key={i}>{line}{i < msg.content.split("\n").length - 1 && <br />}</span>)}</div>);
    }
    return out;
  }

  // ─── Render helpers: HomeScreen-style input ──────────────────────────

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
              setSessions((prev) => prev.map((s) => s.id === activeId ? { ...s, notifications: s.notifications.filter((nn) => nn.id !== n.id) } : s));
            }}>✕</button>
          </div>
        ))}
      </div>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────

  // Show minimal HomeScreen if no active session
  if (!activeSess) {
    return (
      <div className="app">
        <div className="hs-container">
          <div className="hs-bg-layer">
            <div className="hs-bg-orb hs-bg-orb-1" />
            <div className="hs-bg-orb hs-bg-orb-2" />
            <div className="hs-bg-orb hs-bg-orb-3" />
          </div>
          <div className="logo-bar">
            <h1>AlayaFace</h1>
            <div className="connection-controls">
              <input type="text" placeholder="alayacore binary path (auto-detect)" value={binaryPath} onChange={(e) => setBinaryPath(e.target.value)} className="binary-input" />
              <button onClick={handleCreateSession} className="connect-btn">+ New Session</button>
            </div>
          </div>
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
            <input type="text" placeholder="alayacore binary path (auto-detect)" value={binaryPath} onChange={(e) => setBinaryPath(e.target.value)} className="binary-input" />
            <button onClick={handleCreateSession} className="connect-btn">+ New Session</button>
            <button onClick={handleSaveSession} disabled={activeSess.messages.length === 0} className="save-btn" title="Save session to file">Save</button>
            <button onClick={handleForkSession} disabled={activeSess.messages.length === 0} className="fork-btn" title="Fork session up to history ID">Fork</button>
            <button onClick={() => { setShowLogs(!showLogs); if (!showLogs) fetchStderr(); }} className="log-btn">Logs</button>
          </div>
        </div>

        {/* Tab bar */}
        {sessions.length > 0 && (
          <div className="tab-bar">
            {sessions.map((s) => (
              <div key={s.id} className={`tab ${s.id === activeId ? "tab-active" : ""} ${!s.connected ? "tab-disconnected" : ""}`} onClick={() => switchSession(s.id)}>
                <span className="tab-dot" />
                <span className="tab-label">Session {sessions.indexOf(s) + 1}</span>
                <button className="tab-close" onClick={(e) => { e.stopPropagation(); handleCloseSession(s.id); }} title="Close session">✕</button>
              </div>
            ))}
          </div>
        )}

        {activeSess && (
          <>
            <div className={`status ${activeSess.connected ? "connected" : "disconnected"}`}>{activeSess.statusMsg}</div>
          </>
        )}
      </header>

      {/* Chat area */}
      <div className={`chat-area ${activeSess.messages.length === 0 ? "chat-area-centered" : ""}`}>
        {activeSess.messages.length === 0 ? (
          /* ─── HomeScreen-style welcome ─── */
          <div className="hs-container-inline">
            <div className="hs-logo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
                <path d="M19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" opacity="0.6"/>
              </svg>
              <span>AlayaFace</span>
            </div>
            <div className="hs-tagline">AI-powered search &amp; reasoning</div>
            {renderSearchBox()}
          </div>
        ) : (
          /* ─── Messages + Input ─── */
          <>
            <div className="messages">
              {activeSess.messages.map((msg) => (
                <div key={msg.id} className={`message message-${msg.role}`}>
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
              {Array.from(activeSess.streamContents.entries()).filter(([_, c]) => c.length > 0).slice(-1).map(([sid]) => (
                <div key={`cursor-${sid}`} className="message message-assistant cursor-blink">▊</div>
              ))}
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
