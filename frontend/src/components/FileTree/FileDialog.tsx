import { useEffect, useRef, useState } from "react";
import { IconCheck, IconClose } from "../Icon";
import "./FileTree.css";

type DialogMode = "file" | "folder";

interface FileDialogProps {
  mode: DialogMode;
  parentPath: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function FileDialog({ mode, parentPath, onClose, onSubmit }: FileDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    if (/[<>:"|?*]/.test(trimmed)) {
      setError('Name cannot contain: < > : " | ? *');
      return;
    }
    setError("");
    onSubmit(trimmed);
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  const title = mode === "folder" ? "New Folder" : "New File";
  const placeholder = mode === "folder" ? "e.g. components" : "e.g. index.ts";
  const icon = mode === "folder" ? "📁" : "📄";

  return (
    <div className="file-dialog-backdrop" onClick={handleCancel}>
      <div className="file-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="file-dialog-header">
          <div className="file-dialog-title row">
            <span className="file-dialog-icon">{icon}</span>
            <span>{title}</span>
          </div>
          <button className="file-dialog-close icon-btn" onClick={handleCancel} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <form className="file-dialog-body" onSubmit={handleSubmit}>
          <div className="file-dialog-path row">
            <span className="file-dialog-path-label">{parentPath}</span>
            <span className="file-dialog-separator">/</span>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              onKeyDown={(e) => { if (e.key === "Escape") handleCancel(); }}
              placeholder={placeholder}
              autoFocus
              spellCheck={false}
            />
          </div>
          {error && <p className="file-dialog-error">{error}</p>}
          <div className="file-dialog-footer row">
            <span className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
            <button type="submit" className="btn btn-primary">
              <IconCheck size={14} /> <span>{mode === "folder" ? "Create Folder" : "Create File"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}