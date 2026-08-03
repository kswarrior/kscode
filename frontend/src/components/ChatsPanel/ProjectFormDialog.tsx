import { useState } from "react";
import type { Project } from "../../types";
import { IconClose, IconPlus } from "../Icon";

interface Props {
  mode: "add" | "edit";
  initial?: Project;
  onClose: () => void;
  onSubmit: (name: string, path: string, create: boolean) => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * ProjectFormDialog — add or edit a project (name + path)
 * ------------------------------------------------------------------ */
export function ProjectFormDialog({ mode, initial, onClose, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [path, setPath] = useState(initial?.path ?? "");
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isEdit = mode === "edit";
  const canSubmit = !!name.trim() && !!path.trim() && !busy;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onSubmit(name.trim(), path.trim(), create);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cp-dialog-backdrop" onClick={onClose}>
      <div className="cp-dialog glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="cp-dialog-head">
          <span className="cp-dialog-title row">
            <IconPlus size={16} /> {isEdit ? "Edit Project" : "Add Project"}
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="cp-dialog-body">
          <label className="field">
            <span>Project name</span>
            <input
              type="text"
              value={name}
              placeholder="my-app"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Project root path</span>
            <input
              type="text"
              value={path}
              placeholder="/home/user/code/my-app"
              onChange={(e) => setPath(e.target.value)}
            />
            {!isEdit && (
              <label className="cp-checkbox-row">
                <input
                  type="checkbox"
                  checked={create}
                  onChange={(e) => setCreate(e.target.checked)}
                />
                <span>Create this path (mkdir -p) if it does not exist</span>
              </label>
            )}
          </label>
          {err && <p className="cp-form-err">{err}</p>}
        </div>
        <div className="cp-dialog-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? "Working…" : isEdit ? "Save" : "Add Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
