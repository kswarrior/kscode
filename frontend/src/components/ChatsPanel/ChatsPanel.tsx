import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useProjects } from "../../hooks/useProjects";
import type { Chat, Project } from "../../types";
import { ChatPanel } from "../Chat/ChatPanel";
import { IconChat, IconCheck, IconClose, IconFolderOpen, IconPlus } from "../Icon";
import "./ChatsPanel.css";

export type ProjectsApi = ReturnType<typeof useProjects>;

interface Props {
  onOpenEditor?: () => void;
  // Shared projects api from the layout so the header dropdown and the chat
  // list react to the same active-project state (owner: WorkspaceLayout).
  projectsApi?: ProjectsApi;
}

/**
 * Left chat panel: project dropdown at top, new-chat button, chat list.
 * When a chat is selected the conversation renders to the right (inside
 * the same panel). When no project exists, only an "Add project" button is shown.
 */
export function ChatsPanel({ onOpenEditor, projectsApi }: Props) {
  void onOpenEditor;
  const projects = projectsApi ?? useProjects();
  const { projects: list, active } = projects;
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<{ id: string; title: string; messages?: Chat["messages"]; provider?: string; model?: string } | null>(null);
  const [renaming, setRenaming] = useState<Chat | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mobileView, setMobileView] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    const apply = () => setMobileView(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  const isMobileView = () => mobileView;

  // Load chats for the active project.
  const reloadChats = useCallback(async () => {
    if (!active) {
      setChats([]);
      setActiveChat(null);
      return;
    }
    setLoadingChats(true);
    setChatsError(null);
    try {
      const { chats } = await api.chats.list(active.id);
      setChats(chats ?? []);
    } catch (e: any) {
      setChatsError(e?.message ?? String(e));
    } finally {
      setLoadingChats(false);
    }
  }, [active]);

  useEffect(() => {
    setActiveChat(null);
    reloadChats();
  }, [reloadChats]);

  const newChat = async () => {
    if (!active) return;
    try {
      const c = await api.chats.create(active.id);
      setChats((cur) => [c, ...cur]);
      setActiveChat({ id: c.id, title: c.title, messages: [], provider: c.provider, model: c.model });
    } catch (e: any) {
      setChatsError(e?.message ?? String(e));
    }
  };

  const removeChat = async (c: Chat) => {
    if (!active) return;
    if (!confirm(`Delete chat "${c.title || "Untitled"}"?`)) return;
    try {
      const { chats } = await api.chats.remove(active.id, c.id);
      setChats(chats ?? []);
      if (activeChat?.id === c.id) setActiveChat(null);
    } catch (e: any) {
      alert(e?.message ?? String(e));
    }
  };

  const startRename = (c: Chat) => {
    setRenaming(c);
    setRenameValue(c.title || "");
  };

  const commitRename = async () => {
    if (!renaming || !active) return;
    const title = renameValue.trim();
    if (!title || title === renaming.title) {
      setRenaming(null);
      return;
    }
    try {
      const updated = await api.chats.rename(active.id, renaming.id, title);
      setChats((cur) => cur.map((x) => (x.id === updated.id ? updated : x)));
      if (activeChat?.id === updated.id) {
        setActiveChat({ ...activeChat, title: updated.title });
      }
    } catch (e: any) {
      alert(e?.message ?? String(e));
    } finally {
      setRenaming(null);
    }
  };

  const handleOpenChat = (c: Chat) => {
    setActiveChat({
      id: c.id,
      title: c.title,
      messages: c.messages,
      provider: c.provider,
      model: c.model,
    });
  };

  const hasProjects = list.length > 0;

  return (
    <div className={"chats-panel" + (activeChat ? " chats-panel-has-convo" : "")}>
      {(!activeChat || !isMobileView()) && (
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
                <button
                  className="btn btn-primary chats-new-btn"
                  onClick={newChat}
                  title="New chat"
                  disabled={!active}
                >
                  <IconPlus size={14} /> <span>New chat</span>
                </button>
              </div>

              <div className="chats-list-scroll">
                {loadingChats && <p className="chats-status">Loading…</p>}
                {chatsError && <p className="chats-error">{chatsError}</p>}
                {!active && <p className="chats-hint">Select a project from the header to view its chats.</p>}
                {active && !loadingChats && chats.length === 0 && (
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
                        onClick={() => !isRenaming && handleOpenChat(c)}
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
      )}

      {activeChat && active && (
        <div className="chats-conversation">
          <div className="chats-conversation-head">
            <button
              className="chats-convo-back icon-btn"
              onClick={() => setActiveChat(null)}
              title="Back to chat list"
              aria-label="Back to chat list"
            >
              <IconClose size={16} />
            </button>
            <span className="chats-convo-title" title={activeChat.title}>{activeChat.title || "Untitled"}</span>
          </div>
          <div className="chats-conversation-body">
            <ChatPanel
              project={{ id: active.id, name: active.name, path: active.path }}
              chat={activeChat}
            />
          </div>
        </div>
      )}
    </div>
  );
}

