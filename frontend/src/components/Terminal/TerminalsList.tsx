import type { ShellSession } from "../../types";
import { useTerminals } from "../../hooks/useTerminals";
import { IconCheck, IconClose, IconPlus, IconTerminal } from "../Icon";
import "../ChatsPanel/ChatsPanel.css";

interface Props {
  active: ReturnType<typeof useTerminals>;
  onClose: () => void;
  onOpenTerminal?: () => void;
}

/**
 * Terminal list rendered in the app sidebar when the Terminal page is open.
 * Mirrors the ChatsList component, but manages server-side PTY sessions
 * instead of persisted chats.
 */
export function TerminalsList({ active, onClose, onOpenTerminal }: Props) {
  const {
    terminals,
    loading,
    error,
    activeId,
    renaming,
    renameValue,
    setRenameValue,
    setRenaming,
    newTerminal,
    handleOpen,
    removeTerminal,
    startRename,
    commitRename,
  } = active;

  return (
    <div className="chats-sidebar">
      <div className="chats-list-head">
        <span className="chats-list-title">Terminals</span>
        <div className="chats-list-actions">
          <button
            className="btn btn-primary chats-new-btn"
            onClick={newTerminal}
            title="New terminal"
          >
            <IconPlus size={14} /> <span>New</span>
          </button>
          <button
            className="sidebar-close icon-btn"
            onClick={onClose}
            aria-label="Close sidebar"
            title="Close sidebar"
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      <div className="chats-list-scroll">
        {loading && <p className="chats-status">Loading…</p>}
        {error && <p className="chats-error">{error}</p>}
        {terminals.length === 0 && !loading && (
          <p className="chats-hint">No terminals yet. Click <strong>New</strong> to open a shell.</p>
        )}
        <ul className="chats-list">
          {terminals.map((t) => {
            const isRenaming = renaming?.id === t.id;
            const isActive = activeId === t.id;
            return (
              <li
                key={t.id}
                className={"chats-item" + (isActive ? " chats-item-active" : "")}
                onClick={() => { if (isRenaming) return; handleOpen(t); onOpenTerminal?.(); }}
              >
                {isRenaming ? (
                  <div className="chats-item-rename">
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                      autoFocus
                    />
                    <button className="chats-rename-ok" onClick={(e) => { e.stopPropagation(); commitRename(); }} title="Save">
                      <IconCheck size={13} />
                    </button>
                    <button className="chats-rename-cancel" onClick={(e) => { e.stopPropagation(); setRenaming(null); }} title="Cancel">
                      <IconClose size={13} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="chats-item-icon">
                      <IconTerminal size={14} />
                    </span>
                    <span className="chats-item-name" title={t.name || t.id.slice(0, 8)}>
                      {t.name || `Terminal ${t.id.slice(0, 4)}`}
                    </span>
                    <div className="chats-item-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="chats-item-btn" title="Rename" onClick={() => startRename(t)} aria-label="Rename terminal">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14 4l6 6-10 10H4v-6z" />
                          <line x1="14" y1="4" x2="20" y2="10" />
                        </svg>
                      </button>
                      <button className="chats-item-btn chats-item-del" title="Stop terminal" onClick={() => removeTerminal(t)} aria-label="Stop terminal">
                        <IconClose size={13} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
