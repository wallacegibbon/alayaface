import { useState, useRef, useCallback, useEffect } from "react";
import {
  type MediaItem,
  type StagedMedia,
  type SessionState,
  MEDIA_ICON,
  uploadItems,
  shortName,
  fileToDataUri,
} from "../types";

interface InputBarProps {
  session: SessionState;
  onSetInput: (val: string) => void;
  onRemoveStaged: (id: string) => void;
  onAddStaged: (item: StagedMedia) => void;
  onSend: () => void;
  onCancelTask: () => void;
  onSetModel: (modelId: number) => void;
  sendingRef: React.MutableRefObject<boolean>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

function InputBar({
  session,
  onSetInput,
  onRemoveStaged,
  onAddStaged,
  onSend,
  onCancelTask,
  onSetModel,
  sendingRef,
  inputRef,
}: InputBarProps) {
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const uploadDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target as Node)) setShowUploadMenu(false);
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setShowModelMenu(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  const handleUploadClick = useCallback((accept: string, type: string) => {
    setShowUploadMenu(false);
    if (type === "url") {
      // Let parent handle URL modal
      onAddStaged({ id: `url-pending-${Date.now()}`, media_type: "image", uri: "", name: "" });
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
          const newItem: StagedMedia = { id: crypto.randomUUID(), media_type: type as MediaItem["media_type"], uri, name: file.name };
          onAddStaged(newItem);
        } catch { /* */ }
      }
      cleanup();
    };
    input.addEventListener("cancel", cleanup);
    document.body.appendChild(input);
    input.click();
  }, [onAddStaged]);

  const handleModelClick = useCallback(() => {
    setShowModelMenu((prev) => !prev);
  }, []);

  const handleSend = useCallback(() => {
    if (sendingRef.current || session.taskRunning) return;
    onSend();
  }, [sendingRef, session.taskRunning, onSend]);

  return (
    <div className="hs-search-wrapper">
      <div className="hs-search-form">
        {session.staged.length > 0 && (
          <div className="hs-staged-row">
            {session.staged.map((m) => (
              <div key={m.id} className="hs-staged-chip">
                <span className="hs-staged-icon">{MEDIA_ICON[m.media_type]}</span>
                <span className="hs-staged-name">{shortName(m.uri, m.name)}</span>
                <button className="hs-staged-remove" onClick={() => onRemoveStaged(m.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="hs-search-input"
          placeholder={session.staged.length > 0 ? "Add a message…" : "Type a message…"}
          value={session.input}
          onChange={(e) => onSetInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!session.connected}
          rows={1}
        />
        <div className="hs-search-controls">
          <div className="hs-controls-left">
            <div className="hs-menu-container" ref={uploadMenuRef}>
              <button
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
            {session.models.length > 0 && (
              <div className="hs-menu-container" ref={modelMenuRef}>
                <button
                  type="button"
                  className="hs-control-button-with-text hs-model-button"
                  onClick={handleModelClick}
                  title="Select model"
                >
                  <span className="hs-model-button-label">
                    {session.activeModelName || "Model"}
                  </span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {showModelMenu && (
                  <div ref={modelDropdownRef} className="hs-dropdown-menu hs-model-menu hs-dropdown-up" style={{ maxHeight: 260, overflowY: "auto" }}>
                    {session.models.map((model) => (
                      <div
                        key={model.id}
                        className={`hs-menu-item hs-model-item ${session.activeModelId === model.id ? "hs-model-selected" : ""}`}
                        onClick={() => {
                          onSetModel(model.id);
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
            {session.contextLimit > 0 && (
              <span className="hs-token-pct">{session.contextTokens.toLocaleString()} / {session.contextLimit.toLocaleString()}</span>
            )}
            <button
              className={`hs-send-btn${session.taskRunning ? ' cancel' : ''}`}
              onClick={session.taskRunning ? onCancelTask : handleSend}
              disabled={!session.connected || (session.taskRunning ? false : (!session.input.trim() && session.staged.length === 0))}
              title={session.taskRunning ? 'Cancel' : 'Send'}
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
}

export default InputBar;
