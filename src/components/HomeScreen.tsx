import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./HomeScreen.css";

// ─── Icons ────────────────────────────────────────────────────────────

const MicrophoneIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);

const AudioWaveIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="8" width="2" height="8" rx="1"/>
    <rect x="8" y="5" width="2" height="14" rx="1"/>
    <rect x="12" y="3" width="2" height="18" rx="1"/>
    <rect x="16" y="6" width="2" height="12" rx="1"/>
    <rect x="20" y="9" width="2" height="6" rx="1"/>
  </svg>
);

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const ImageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>
);

const VideoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="23 7 16 12 23 17 23 7"/>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
  </svg>
);

const DocumentIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);

const AudioFileIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 18V5l12-2v13"/>
    <circle cx="6" cy="18" r="3"/>
    <circle cx="18" cy="16" r="3"/>
  </svg>
);

const LinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);

const SparklesIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/>
    <path d="M19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" opacity="0.6"/>
    <path d="M5 17l0.7 2 2 0.7-2 0.7L5 22.3l-0.7-2-2-0.7 2-0.7L5 17z" opacity="0.4"/>
  </svg>
);

const LoaderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="hs-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

// ─── Smart Dropdown Positioning ───────────────────────────────────────

interface DropdownStyle {
  maxHeight: number;
  above: boolean;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

function useDropdownPosition(
  isOpen: boolean,
  triggerRef: React.RefObject<HTMLElement | null>,
  _menuRef: React.RefObject<HTMLElement | null>,
  gap: number = 8
): DropdownStyle & { recalc: () => void } {
  const noop = useCallback(() => {}, []);
  const [style, setStyle] = useState<DropdownStyle & { recalc: () => void }>({ maxHeight: 260, above: true, recalc: noop });

  const recalc = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const padding = 12;

    // Space above and below the trigger
    const spaceAbove = rect.top - padding;
    const spaceBelow = viewportH - rect.bottom - padding;

    // Prefer above, flip to below if not enough space
    const above = spaceAbove >= spaceBelow;

    // Max height: available space minus gap, clamped to a reasonable range
    const available = above ? spaceAbove - gap : spaceBelow - gap;
    const maxHeight = Math.max(80, Math.min(available, 360));

    // Vertical position (viewport-relative for position:fixed)
    const top = above ? undefined : rect.bottom + gap;
    const bottom = above ? viewportH - rect.top + gap : undefined;

    // Horizontal: keep within viewport
    const menuWidth = _menuRef.current?.offsetWidth || 240;
    let left: number | undefined;
    let right: number | undefined;

    if (rect.left + menuWidth > viewportW - padding) {
      // Would overflow right — align right edge of menu with right edge of trigger
      right = viewportW - rect.right;
    } else {
      left = rect.left;
    }

    setStyle({ maxHeight, above, top, bottom, left, right, recalc });
  }, [triggerRef, _menuRef, gap]);

  useEffect(() => {
    if (isOpen) {
      // Delay slightly so the DOM has rendered with new content
      const id = requestAnimationFrame(() => recalc());
      window.addEventListener("resize", recalc);
      return () => {
        cancelAnimationFrame(id);
        window.removeEventListener("resize", recalc);
      };
    }
  }, [isOpen, recalc]);

  return { ...style, recalc };
}

// ─── Data ─────────────────────────────────────────────────────────────

const uploadItems = [
  { icon: <ImageIcon />, label: "Image", accept: "image/*", type: "image" as const },
  { icon: <AudioFileIcon />, label: "Audio", accept: "audio/*", type: "audio" as const },
  { icon: <VideoIcon />, label: "Video", accept: "video/*", type: "video" as const },
  { icon: <DocumentIcon />, label: "Document", accept: ".pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.toml,.html,.css,.js,.ts,.rs,.py,.go,.java,.c,.cpp,.h,.hpp", type: "document" as const },
  { icon: <LinkIcon />, label: "From URL", accept: "", type: "url" as const },
];

interface ModelItem {
  id: number;
  name: string;
}

// ─── Component ────────────────────────────────────────────────────────

function HomeScreen() {
  const [inputValue, setInputValue] = useState("");
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const selectedModelName = models.find((m) => m.id === selectedModelId)?.name ?? null;
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const uploadTriggerRef = useRef<HTMLButtonElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const uploadDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelLabelRef = useRef<HTMLSpanElement>(null);
  const [modelLabelOverflow, setModelLabelOverflow] = useState(false);

  // Check if model label text overflows
  useEffect(() => {
    const el = modelLabelRef.current;
    if (el) {
      setModelLabelOverflow(el.scrollWidth > el.clientWidth);
    }
  }, [selectedModelName]);

  // Smart positioning for dropdowns
  const uploadPos = useDropdownPosition(showUploadMenu, uploadTriggerRef, uploadDropdownRef);
  const modelPos = useDropdownPosition(showModelMenu, modelTriggerRef, modelDropdownRef);

  // Close menus when clicking outside
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

  const fetchModels = useCallback(async () => {
    if (models.length > 0 || modelsLoading) return;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await invoke<{ id: number; name: string }[]>("list_models", { binaryPath: "" });
      setModels(result);
      // Recalculate position after content changes width
      requestAnimationFrame(() => modelPos.recalc());
    } catch (err) {
      setModelsError(String(err));
      console.error("Failed to list models:", err);
    } finally {
      setModelsLoading(false);
    }
  }, [models.length, modelsLoading, modelPos.recalc]);

  const handleModelClick = () => {
    if (!showModelMenu && models.length === 0) {
      fetchModels();
    }
    setShowModelMenu(!showModelMenu);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      console.log("Query:", inputValue);
    }
  };

  const handleUploadClick = (accept: string, type: string) => {
    setShowUploadMenu(false);
    if (type === "url") {
      const url = prompt("Enter URL:");
      if (url) console.log("URL:", url);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        console.log("Selected:", file.name, type);
      }
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    document.body.appendChild(input);
    input.click();
  };

  // Build dynamic style for a dropdown (position:fixed, viewport-relative coords)
  const dropdownStyle = (pos: DropdownStyle): React.CSSProperties => {
    const s: React.CSSProperties = {
      maxHeight: pos.maxHeight,
      overflowY: "auto",
    };
    if (pos.top !== undefined) s.top = pos.top;
    if (pos.bottom !== undefined) s.bottom = pos.bottom;
    if (pos.left !== undefined) s.left = pos.left;
    if (pos.right !== undefined) s.right = pos.right;
    return s;
  };

  return (
    <div className="hs-container">
      {/* Background orbs (fixed layer, clipped to viewport) */}
      <div className="hs-bg-layer">
        <div className="hs-bg-orb hs-bg-orb-1" />
        <div className="hs-bg-orb hs-bg-orb-2" />
        <div className="hs-bg-orb hs-bg-orb-3" />
      </div>

      {/* Logo */}
      <div className="hs-logo">
        <SparklesIcon />
        <span>AlayaFace</span>
      </div>
      <div className="hs-tagline">AI-powered search &amp; reasoning</div>

      {/* Search Box */}
      <div className="hs-search-wrapper">
        <form onSubmit={handleSubmit} className="hs-search-form">
          <input
            ref={inputRef}
            type="text"
            className={`hs-search-input ${isFocused ? "focused" : ""}`}
            placeholder={isFocused ? "Ask anything..." : "Type / for search modes"}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          />

          {/* Bottom Controls */}
          <div className="hs-search-controls">
            <div className="hs-controls-left">
              {/* Upload / Attach Button */}
              <div className="hs-menu-container" ref={uploadMenuRef}>
                <button
                  ref={uploadTriggerRef}
                  type="button"
                  className="hs-control-button hs-attach-btn"
                  onClick={() => setShowUploadMenu(!showUploadMenu)}
                  title="Attach files"
                >
                  <PlusIcon />
                </button>
                {showUploadMenu && (
                  <div
                    ref={uploadDropdownRef}
                    className="hs-dropdown-menu hs-upload-menu"
                    style={dropdownStyle(uploadPos)}
                  >
                    {uploadItems.map((item, index) => (
                      <div
                        key={index}
                        className="hs-menu-item"
                        onClick={() => handleUploadClick(item.accept, item.type)}
                      >
                        <span className="hs-menu-item-icon">{item.icon}</span>
                        <span className="hs-menu-item-label">{item.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="hs-controls-right">
              {/* Model Button */}
              <div className="hs-menu-container" ref={modelMenuRef}>
                <button
                  ref={modelTriggerRef}
                  type="button"
                  className="hs-control-button-with-text hs-model-button"
                  onClick={handleModelClick}
                >
                  <span ref={modelLabelRef} className={`hs-model-button-label ${modelLabelOverflow ? "hs-fade" : ""}`}>
                    {selectedModelName || "Model"}
                  </span>
                  <ChevronDownIcon />
                </button>
                {showModelMenu && (
                  <div
                    ref={modelDropdownRef}
                    className="hs-dropdown-menu hs-model-menu"
                    style={dropdownStyle(modelPos)}
                  >
                    {modelsLoading && (
                      <div className="hs-menu-loading"><LoaderIcon /> Loading models…</div>
                    )}
                    {modelsError && (
                      <div className="hs-menu-empty">
                        Failed to load models: {modelsError}
                      </div>
                    )}
                    {!modelsLoading && !modelsError && models.length === 0 && (
                      <div className="hs-menu-empty">
                        No models found
                      </div>
                    )}
                    {models.map((model) => (
                      <div
                        key={model.id}
                        className={`hs-menu-item hs-model-item ${selectedModelId === model.id ? "hs-model-selected" : ""}`}
                        onClick={() => {
                          setSelectedModelId(model.id);
                          setShowModelMenu(false);
                        }}
                      >
                        <span className="hs-model-name">{model.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Microphone Button */}
              <button type="button" className="hs-control-button" title="Voice input">
                <MicrophoneIcon />
              </button>

              {/* Audio Wave Button */}
              <button type="button" className="hs-control-button hs-audio-button" title="Audio mode">
                <AudioWaveIcon />
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Quick suggestions */}
      <div className="hs-suggestions">
        <button className="hs-suggestion-chip">Explain quantum computing</button>
        <button className="hs-suggestion-chip">Write a Python script</button>
        <button className="hs-suggestion-chip">Compare AI models</button>
        <button className="hs-suggestion-chip">Debug my code</button>
      </div>
    </div>
  );
}

export default HomeScreen;
