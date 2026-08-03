import { useEffect, useRef, useState } from "react";
import type { Project } from "../../types";
import {
  IconChevronDown,
  IconClose,
  IconFolderOpen,
  IconPlus,
  IconCheck,
} from "../Icon";
import "./ProjectDropdownMenu.css";

interface Props {
  projects: Project[];
  active: Project | null;
  onOpenProject: (p: Project) => Promise<void>;
  onAddProject: () => void;
  onRename: (p: Project) => void;
  onEdit: (p: Project) => void;
  onDelete: (p: Project) => void;
}

/**
 * Project selector shown at the top-left of the chat panel.
 * - Trigger shows the active project name (or "Select project").
 * - The dropdown menu lists every project with a 3-dot menu (rename/edit/delete).
 * - The top-right of the menu shows an "Add project" button.
 */
export function ProjectDropdownMenu({
  projects,
  active,
  onOpenProject,
  onAddProject,
  onRename,
  onEdit,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Project | null>(null);
  const [renameDialogValue, setRenameDialogValue] = useState<string | null>(null);
  const [renamingP, setRenamingP] = useState<Project | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMenuFor(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setMenuFor(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectProject = async (p: Project) => {
    if (active?.id === p.id) {
      setOpen(false);
      return;
    }
    await onOpenProject(p);
    setOpen(false);
  };

  const commitRename = async () => {
    if (!renamingP || renameDialogValue === null) return;
    const trimmed = renameDialogValue.trim();
    if (!trimmed || trimmed === renamingP.name) {
      setRenamingP(null);
      setRenameDialogValue(null);
      return;
    }
    const p = renamingP;
    setRenamingP(null);
    setRenameDialogValue(null);
    onRename(p);
  };

  const cancelRename = () => {
    setRenamingP(null);
    setRenameDialogValue(null);
  };

  const triggerLabel = active ? active.name : "Select project";

  return (
    <div className={"pdm" + (open ? " pdm-open" : "")} ref={wrapRef}>
      <button
        type="button"
        className="pdm-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active?.path ?? "Select a project"}
      >
        <span className="pdm-trigger-icon"><IconFolderOpen size={15} /></span>
        <span className="pdm-trigger-label">{triggerLabel}</span>
        <span className="pdm-trigger-caret"><IconChevronDown size={13} /></span>
      </button>

      {open && (
        <div className="pdm-menu glass-strong" role="listbox">
          <div className="pdm-menu-head">
            <span className="pdm-menu-title">Projects</span>
            <button
              type="button"
              className="pdm-add-btn"
              onClick={() => {
                setOpen(false);
                setMenuFor(null);
                onAddProject();
              }}
              title="Add project"
            >
              <IconPlus size={15} /> <span>Add</span>
            </button>
          </div>

          <ul className="pdm-list">
            {projects.length === 0 && (
              <li className="pdm-empty">
                <p>No projects yet.</p>
                <button
                  type="button"
                  className="pdm-empty-add"
                  onClick={() => {
                    setOpen(false);
                    onAddProject();
                  }}
                >
                  <IconPlus size={15} /> Add project
                </button>
              </li>
            )}
            {projects.map((p) => {
              const isActive = active?.id === p.id;
              const showMenu = menuFor?.id === p.id;
              const isRenaming = renamingP?.id === p.id;
              return (
                <li
                  key={p.id}
                  className={
                    "pdm-item" +
                    (isActive ? " pdm-item-active" : "") +
                    (showMenu ? " pdm-item-menu-open" : "")
                  }
                >
                  {isRenaming ? (
                    <div className="pdm-rename-row">
                      <input
                        type="text"
                        value={renameDialogValue ?? renamingP.name}
                        onChange={(e) => setRenameDialogValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === "Escape") {
                            cancelRename();
                          }
                        }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="pdm-rename-ok"
                        onClick={(e) => { e.stopPropagation(); commitRename(); }}
                        title="Save"
                        disabled={renameDialogValue === null || !renameDialogValue.trim()}
                      >
                        <IconCheck size={14} />
                      </button>
                      <button
                        type="button"
                        className="pdm-rename-cancel"
                        onClick={(e) => { e.stopPropagation(); cancelRename(); }}
                        title="Cancel"
                      >
                        <IconClose size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="pdm-item-main"
                      onClick={() => selectProject(p)}
                    >
                      <span className="pdm-item-name">{p.name}</span>
                      {isActive && <span className="pdm-item-path" title={p.path}>{p.path}</span>}
                      {isActive && <span className="pdm-item-badge"><IconCheck size={12} /></span>}
                    </button>
                  )}

                  {!isRenaming && (
                    <div className="pdm-item-actions">
                      <button
                        type="button"
                        className="pdm-dots"
                        aria-label="Project menu"
                        aria-haspopup="menu"
                        aria-expanded={showMenu}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor(showMenu ? null : p);
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <circle cx="12" cy="5" r="1.6" />
                          <circle cx="12" cy="12" r="1.6" />
                          <circle cx="12" cy="19" r="1.6" />
                        </svg>
                      </button>

                      {showMenu && (
                        <ul
                          className="pdm-submenu glass-strong"
                          role="menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <li className="pdm-sub-head" title={p.path}>{p.path}</li>
                          <li
                            role="menuitem"
                            className="pdm-sub-item"
                            onClick={() => { setMenuFor(null); onRename(p); }}
                          >
                            Rename
                          </li>
                          <li
                            role="menuitem"
                            className="pdm-sub-item"
                            onClick={() => { setMenuFor(null); onEdit(p); }}
                          >
                            Edit
                          </li>
                          <li
                            role="menuitem"
                            className="pdm-sub-item pdm-sub-danger"
                            onClick={() => { setMenuFor(null); onDelete(p); }}
                          >
                            Delete
                          </li>
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
