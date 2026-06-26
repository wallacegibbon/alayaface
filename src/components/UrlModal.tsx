import { useState, useEffect, useRef } from "react";

interface UrlModalProps {
  initialType: string;
  onClose: () => void;
  onConfirm: (url: string, type: string) => void;
}

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

export default UrlModal;
