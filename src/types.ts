// ─── TLV Protocol Types ──────────────────────────────────────────────

export interface DeltaEvent {
  session_id: string;
  history_id: string;
  content: string;
  tag: "AT" | "AR";
}

export interface FrameEvent {
  session_id: string;
  tag: string;
  raw_value: string;
  history_id: string | null;
  content: string | null;
  json: Record<string, unknown> | null;
  user_content_type: string | null;
}

export interface StatusEvent {
  session_id: string;
  connected: boolean;
  message: string;
}

// ─── Media Types ─────────────────────────────────────────────────────

export interface MediaItem {
  media_type: "image" | "audio" | "video" | "document";
  uri: string;
  name?: string;
}

export interface StagedMedia extends MediaItem {
  id: string;
}

// ─── Message Types ───────────────────────────────────────────────────

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "reasoning";
  content: string;
  tool_id?: string;
  tool_name?: string;
  is_error?: boolean;
  history_id?: string;
  media?: MediaItem[];
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  is_error?: boolean;
  started: boolean;
  input_received: boolean;
}

export interface NotificationItem {
  id: string;
  type: "notify" | "error";
  text: string;
  timestamp: number;
}

export interface SessionState {
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
  historyContents: Map<string, string>;
  historyRoles: Map<string, "assistant" | "reasoning">;
  toolCalls: Map<string, ToolCall>;
  stderrLines: string[];
  notifications: NotificationItem[];
  input: string;
  /** Pending user content being accumulated from echo frames */
  pendingUserParts: PendingUserPart[];
  /** Whether we're waiting for user echoes after sending */
  sendPending: boolean;
}

export interface PendingUserPart {
  id: string;
  historyId: string;
  tag: string;
  content: string;
  media_type?: "image" | "audio" | "video" | "document";
}

// ─── Media Helpers ───────────────────────────────────────────────────

export const MEDIA_ACCEPT: Record<string, string> = {
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
  document: ".pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml,.html,.css,.js,.ts,.rs,.py,.go,.java,.c,.cpp,.h,.hpp",
};

export const MEDIA_ICON: Record<string, string> = {
  image: "🖼", audio: "🎵", video: "🎬", document: "📄",
};

export const uploadItems = [
  { icon: "🖼", label: "Image", accept: MEDIA_ACCEPT.image, type: "image" as const },
  { icon: "🎵", label: "Audio", accept: MEDIA_ACCEPT.audio, type: "audio" as const },
  { icon: "🎬", label: "Video", accept: MEDIA_ACCEPT.video, type: "video" as const },
  { icon: "📄", label: "Document", accept: MEDIA_ACCEPT.document, type: "document" as const },
  { icon: "🔗", label: "From URL", accept: "", type: "url" as const },
];

export function shortName(uri: string, name?: string): string {
  if (name) return name;
  if (uri.startsWith("data:")) {
    const mime = uri.split(";")[0]?.replace("data:", "") || "file";
    return `[${mime}]`;
  }
  try {
    const u = new URL(uri);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.pop() || uri;
  } catch {
    return uri.length > 40 ? uri.slice(0, 40) + "…" : uri;
  }
}

// ─── MIME handling ────────────────────────────────────────────────────

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
  const lower = mime.toLowerCase();
  if (MIME_ALIAS[lower]) return MIME_ALIAS[lower];
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

export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
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

// ─── Session Factory ─────────────────────────────────────────────────

export function createSessionState(id: string): SessionState {
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
    historyContents: new Map(),
    historyRoles: new Map(),
    toolCalls: new Map(),
    stderrLines: [],
    notifications: [],
    input: "",
    pendingUserParts: [],
    sendPending: false,
  };
}

// ─── User echo tag detection ─────────────────────────────────────────

const USER_ECHO_TAGS = new Set(["UT", "UI", "UV", "UA", "UD"]);

export function isUserEchoTag(tag: string): boolean {
  return USER_ECHO_TAGS.has(tag);
}

export function echoTagToMediaType(tag: string): MediaItem["media_type"] | null {
  switch (tag) {
    case "UI": return "image" as const;
    case "UV": return "video" as const;
    case "UA": return "audio" as const;
    case "UD": return "document" as const;
    default: return null;
  }
}

export function echoTagToLabel(tag: string): string {
  switch (tag) {
    case "UT": return "text";
    case "UI": return "📎 Image";
    case "UV": return "🎬 Video";
    case "UA": return "🎵 Audio";
    case "UD": return "📄 Document";
    default: return tag;
  }
}
