import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Chat, ChatMessage, Project } from "../types";

export interface ActiveChat {
  id: string;
  title: string;
  messages?: ChatMessage[];
  provider?: string;
  model?: string;
}

// Persist the active chat ID so it restores on page reload.
const STORAGE_KEY = "kscode:activeChatId";

/**
 * Shared state for the chat list (sidebar) and the open conversation
 * (main area). Takes the active project; the list + selection reset when
 * the project changes.
 */
export function useChats(project: Project | null) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [renaming, setRenaming] = useState<Chat | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const reload = useCallback(async () => {
    if (!project) {
      setChats([]);
      setActiveChat(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { chats } = await api.chats.list(project.id);
      setChats(chats ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [project]);

  // On project change: clear the selection, reload the list, then restore
  // the last open chat for this project if one was saved.
  useEffect(() => {
    setActiveChat(null);
    setRenaming(null);
    localStorage.removeItem(STORAGE_KEY);
    reload();
    if (!project) return;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      api.chats.one(project.id, saved)
        .then((c) => setActiveChat({ id: c.id, title: c.title, messages: c.messages, provider: c.provider, model: c.model }))
        .catch(() => localStorage.removeItem(STORAGE_KEY));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    if (activeChat) localStorage.setItem(STORAGE_KEY, activeChat.id);
  }, [activeChat]);

  const newChat = async () => {
    if (!project) return;
    try {
      const c = await api.chats.create(project.id);
      setChats((cur) => [c, ...cur]);
      setActiveChat({ id: c.id, title: c.title, messages: [], provider: c.provider, model: c.model });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  // Ensure there is an active chat. If one is already selected, return it;
  // otherwise create a new one, select it (so it appears in the sidebar)
  // and return it. Used by the chat composer when the user sends a prompt
  // from the "no chat selected" state — the chat is auto-created on first
  // message and shows up in the sidebar list immediately.
  const ensureChat = async (): Promise<ActiveChat | null> => {
    if (!project) return null;
    if (activeChat) return activeChat;
    try {
      const c = await api.chats.create(project.id);
      setChats((cur) => [c, ...cur]);
      const ac: ActiveChat = { id: c.id, title: c.title, messages: [], provider: c.provider, model: c.model };
      setActiveChat(ac);
      return ac;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return null;
    }
  };

  const handleOpen = async (c: Chat) => {
    if (!project) return;
    try {
      const full = await api.chats.one(project.id, c.id);
      setActiveChat({ id: full.id, title: full.title, messages: full.messages, provider: full.provider, model: full.model });
    } catch (e) {
      // Fallback to list data if fetch fails.
      setActiveChat({ id: c.id, title: c.title, messages: c.messages, provider: c.provider, model: c.model });
    }
  };

  const removeChat = async (c: Chat) => {
    if (!project) return;
    if (!confirm(`Delete chat "${c.title || "Untitled"}"?`)) return;
    try {
      const { chats } = await api.chats.remove(project.id, c.id);
      setChats(chats ?? []);
      if (activeChat?.id === c.id) {
        setActiveChat(null);
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e: any) {
      alert(e?.message ?? String(e));
    }
  };

  const startRename = (c: Chat) => {
    setRenaming(c);
    setRenameValue(c.title || "");
  };

  const commitRename = async () => {
    if (!renaming || !project) return;
    const title = renameValue.trim();
    if (!title || title === renaming.title) {
      setRenaming(null);
      return;
    }
    try {
      const updated = await api.chats.rename(project.id, renaming.id, title);
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

  const back = () => {
    setActiveChat(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return {
    chats,
    loading,
    error,
    activeChat,
    renaming,
    renameValue,
    setRenameValue,
    setRenaming,
    reload,
    newChat,
    ensureChat,
    handleOpen,
    removeChat,
    startRename,
    commitRename,
    back,
  };
}
