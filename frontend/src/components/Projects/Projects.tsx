import { useState } from "react";
import { useProjects } from "../../hooks/useProjects";
import type { Project } from "../../types";
import { Menu } from "../Menu";
import { IconClose, IconFolderOpen, IconPlus } from "../Icon";
import "./Projects.css";

export function ProjectsPanel({
  onViewProject,
  onOpenProject,
}: {
  onViewProject?: (project: Project) => void;
  onOpenProject?: (project: Project) => void;
}) {
  // WorkspaceLayout historically used onOpenProject; older call sites used
  // onViewProject. Accept either so we don't break consumers.
  const handleView = onViewProject ?? onOpenProject;
  const { projects, active, loading, error, add, rename, remove, open } = useProjects();
  const [showAdd, setShowAdd] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);

  const handleCardClick = async (p: Project) => {
    try {
      await open(p.id);
      handleView?.(p);
    } catch (err: any) {
      alert(err?.message ?? String(err));
    }
  };

  return (
    <div className="projects-page">
      <div className="projects-head">
        <h2 className="projects-title">Projects</h2>
        <button
          className="btn btn-primary projects-add"
          onClick={() => setShowAdd(true)}
          title="Add project"
        >
          <IconPlus size={15} /> <span>Add</span>
        </button>
      </div>

      <div className="projects-scroll">
        {loading && <p className="pr-status">Loading…</p>}
        {error && <p className="pr-error">{error}</p>}
        {!loading && projects.length === 0 && (
          <div className="pr-empty-wrap">
            <IconFolderOpen size={26} />
            <p className="pr-empty">No projects yet. Click <strong>Add</strong> to create one.</p>
          </div>
        )}
        <ul className="pr-list">
          {projects.map((p) => {
            const isActive = active?.id === p.id;
            return (
              <li
                key={p.id}
                className={"pr-card" + (isActive ? " pr-card-active" : "")}
                onClick={() => handleCardClick(p)}
              >
                <div className="pr-card-main">
                  <div className="pr-card-head">
                    <IconFolderOpen size={16} />
                    <span className="pr-card-name">{p.name}</span>
                    {isActive && <span className="pr-card-badge">active</span>}
                  </div>
                  <div className="pr-card-path" title={p.path}>{p.path}</div>
                </div>
                <div className="pr-card-actions" onClick={(e) => e.stopPropagation()}>
                  <Menu
                    align="right"
                    ariaLabel="Project menu"
                    items={[
                      { key: "open", label: "Open", onSelect: () => handleCardClick(p) },
                      { key: "rename", label: "Rename", onSelect: () => setRenaming(p) },
                      {
                        key: "delete",
                        label: "Delete from list",
                        danger: true,
                        onSelect: () => {
                          if (confirm(`Remove project "${p.name}"?\n(The on-disk files are NOT deleted.)`)) {
                            remove(p.id).catch((e) => alert(e?.message ?? e));
                          }
                        },
                      },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {showAdd && (
        <ProjectDialog
          title="Add Project"
          submitLabel="Add Project"
          onClose={() => setShowAdd(false)}
          initial={{ name: "", path: "", create: false }}
          onSubmit={async (name, path, create) => {
            try {
              const p = await add(name, path, create);
              setShowAdd(false);
              await open(p.id);
              handleView?.(p);
            } catch (err: any) {
              alert(err?.message ?? String(err));
            }
          }}
        />
      )}

      {renaming && (
        <ProjectDialog
          title={`Rename "${renaming.name}"`}
          submitLabel="Save"
          onClose={() => setRenaming(null)}
          initial={{ name: renaming.name, path: renaming.path, create: false }}
          showCreate={false}
          onSubmit={async (name, path) => {
            try {
              await rename(renaming.id, {
                name: name || undefined,
                path: path || undefined,
              });
              setRenaming(null);
            } catch (err: any) {
              alert(err?.message ?? String(err));
            }
          }}
        />
      )}
    </div>
  );
}

interface DialogState { name: string; path: string; create: boolean; }

function ProjectDialog({
  title,
  submitLabel,
  initial,
  showCreate = true,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial: DialogState;
  showCreate?: boolean;
  onClose: () => void;
  onSubmit: (name: string, path: string, create: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [path, setPath] = useState(initial.path);
  const [create, setCreate] = useState(initial.create);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    <div className="pr-dialog-backdrop" onClick={onClose}>
      <div className="pr-dialog glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="pr-dialog-head">
          <span className="pr-dialog-title row"><IconPlus size={16} /> {title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="pr-dialog-body">
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
            {showCreate && (
              <label className="pr-checkbox-row">
                <input
                  type="checkbox"
                  checked={create}
                  onChange={(e) => setCreate(e.target.checked)}
                />
                <span>Create this path (mkdir -p) if it does not exist</span>
              </label>
            )}
          </label>
          {err && <p className="pr-form-err">{err}</p>}
        </div>
        <div className="pr-dialog-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? "Working…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
