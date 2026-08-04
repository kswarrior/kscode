import type { Project } from "../../types";
import { useChats } from "../../hooks/useChats";
import { IconChat, IconCheck, IconClose, IconFolderOpen, IconPlus } from "../Icon";
import "./ChatsPanel.css";

interface Props {
  hasProjects: boolean;
  active: Project | null;
  chatsApi: ReturnType<typeof useChats>;
  onClose: () => void;
  onOpenChat?: () => void;
}

/**
 * Chat list rendered in the app sidebar when the Chat page is open.
 * Shows every chat belonging to the active project.
 */
export function ChatsList({ hasProjects, active, chatsApi, onClose, onOpenChat }: Props) {
  const {
    chats,
    loading,
    error,
    activeChat,
    renaming,
    renameValue,
    setRenameValue,
    setRenaming,
    newChat,
    handleOpen,
    removeChat,
    startRename,
    commitRename,
  } = chatsApi;

  return (
    <div className="chats-sidebar">
      {!hasProjects ? (
        <div className="chats-empty-state">
          <div className="chats-empty-icon"><IconFolderOpen size={28} /></div>
          <p className="chats-empty-title">No projects yet</p>
          <p className="chats-empty-sub">Add a project from the header dropdown to start chatting with the AI.</p>
        </div>
      ) : (
        <>
          <div className="chats-list-head">
            <span className="chats-list-title">Chats</span>
            <div className="chats-list-actions">
              <button
                className="btn btn-primary chats-new-btn"
                onClick={newChat}
                title="New chat"
                disabled={!active}
              >
                <IconPlus size={14} /> <span>New chat</span>
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
            {!active && <p className="chats-hint">Select a project from the header to view its chats.</p>}
            {active && !loading && chats.length === 0 && (
              <p className="chats-hint">No chats yet. Click <strong>New chat</strong> to begin.</p>
            )}
            <ul className="chats-list">
              {chats.map((c) => {
                const isRenaming = renaming?.id === c.id;
                const isActiveChat = activeChat?.id === c.id;
                return (
                  <li
                    key={c.id}
                    className={"chats-item" + (isActiveChat ? " chats-item-active" : "")}
                    onClick={() => { if (isRenaming) return; handleOpen(c); onOpenChat?.(); }}
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
                        <span className="chats-item-icon"><IconChat size={14} /></span>
                        <span className="chats-item-name" title={c.title}>{c.title || "Untitled"}</span>
                        <div className="chats-item-actions" onClick={(e) => e.stopPropagation()}>
                          <button className="chats-item-btn" title="Rename" onClick={() => startRename(c)} aria-label="Rename chat">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M14 4l6 6-10 10H4v-6z" />
                              <line x1="14" y1="4" x2="20" y2="10" />
                            </svg>
                          </button>
                          <button className="chats-item-btn chats-item-del" title="Delete" onClick={() => removeChat(c)} aria-label="Delete chat">
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
        </>
      )}
    </div>
  );
}
