import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Chat, Project } from "../../types";
import { Menu } from "../Menu";
import { IconChat, IconClose, IconPlus, IconTerminal } from "../Icon";
import "./ProjectView.css";

interface Props {
  project: Project;
  onBack?: () => void;
  onOpenChat?: (projectId: string, chatId: string, chatTitle: string) => void;
}

export function ProjectView({ project, onBack, onOpenChat }: Props) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Chat | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { chats } = await api.chats.list(project.id);
      setChats(chats ?? []);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { reload(); }, [reload]);

  const newChat = async () => {
    try {
      const c = await api.chats.create(project.id);
      setChats((cur) => [c, ...cur]);
      // Chat opens in separate page; onOpenChat will be called from the list.
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const removeChat = async (c: Chat) => {
    if (!confirm(`Delete chat "${c.title}"?`)) return;
    try {
      const { chats } = await api.chats.remove(project.id, c.id);
      setChats(chats ?? []);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const renameChat = async (c: Chat, title: string) => {
    try {
      const updated = await api.chats.rename(project.id, c.id, title);
      setChats((cur) => cur.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e: any) {
      alert(e?.message ?? String(e));
    }
  };

  return (
    <div className="pv">
      <div className="pv-top">
        <div className="pv-brand row">
          <IconTerminal size={16} />
          <span className="pv-project-name" title={project.path}>{project.name}</span>
          <span className="pv-project-path" title={project.path}>{project.path}</span>
        </div>
        <div className="pv-top-right">
          <button className="btn btn-primary pv-new-chat" onClick={newChat} title="New chat">
            <IconPlus size={15} /> <span className="hidden-mobile">New chat</span>
          </button>
          {onBack && (
            <button className="icon-btn" onClick={onBack} title="Back to projects" aria-label="Back">
              <IconClose />
            </button>
          )}
        </div>
      </div>

      <div className="pv-body">
        <aside className="pv-sidebar">
          <div className="pv-sidebar-head">
            <span>Chats</span>
          </div>
          <div className="pv-chats">
            {loading && <p className="pv-status">Loading…</p>}
            {error && <p className="pv-error">{error}</p>}
            {!loading && chats.length === 0 && (
              <p className="pv-empty">No chats yet. Click <strong>New chat</strong> to begin.</p>
            )}
            <ul className="pv-chat-list">
              {chats.map((c) => (
                <li
                  key={c.id}
                  className="pv-chat"
                  onClick={() => onOpenChat?.(project.id, c.id, c.title)}
                >
                  <span className="pv-chat-icon"><IconChat size={14} /></span>
                  <span className="pv-chat-name" title={c.title}>{c.title || "Untitled"}</span>
                  <div className="pv-chat-menu" onClick={(e) => e.stopPropagation()}>
                    <Menu
                      align="right"
                      ariaLabel="Chat menu"
                      items={[
                        { key: "rename", label: "Rename", onSelect: () => setRenaming(c) },
                        {
                          key: "delete",
                          label: "Delete",
                          danger: true,
                          onSelect: () => removeChat(c),
                        },
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {renaming && (
        <RenameChatDialog
          chat={renaming}
          onClose={() => setRenaming(null)}
          onRename={async (title) => {
            await renameChat(renaming, title);
            setRenaming(null);
          }}
        />
      )}
    </div>
  );
}

function RenameChatDialog({
  chat,
  onClose,
  onRename,
}: {
  chat: Chat;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  return (
    <div className="pv-dialog-backdrop" onClick={onClose}>
      <div className="pv-dialog glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="pv-dialog-head">
          <span className="row" style={{ gap: 8, fontWeight: 700, fontSize: 14 }}>Rename chat</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconClose size={16} /></button>
        </div>
        <div className="pv-dialog-body">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (title.trim()) { setBusy(true); onRename(title.trim()).finally(() => setBusy(false)); } } }}
          />
        </div>
        <div className="pv-dialog-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => { if (title.trim()) { setBusy(true); onRename(title.trim()).finally(() => setBusy(false)); } }}
            disabled={busy || !title.trim()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
