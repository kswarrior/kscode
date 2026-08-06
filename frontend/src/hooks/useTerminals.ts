import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ShellSession, Project } from "../types";

// Persist the active terminal ID so it restores on page reload.
const STORAGE_KEY = "kscode:activeTerminalId";

/**
 * Shared state for the terminal list (sidebar) and the open terminal
 * (main area). Terminals are server-side PTY sessions keyed by id; the
 * list is fetched from the backend and refreshes when a new terminal is
 * created or a session exits. Unlike chats, terminals are not scoped per
 * project — they live for the lifetime of the server process.
 */
export function useTerminals(project: Project | null) {
  const [terminals, setTerminals] = useState<ShellSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<ShellSession | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Ref to the active terminal panel's clear function
  const clearTermRef = useRef<(() => void) | null>(null);

  // Keep a ref of the latest activeId so reload() can read it without being
  // re-created on every selection change (avoids stale-closure bugs).
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const setClearTermRef = useCallback((fn: (() => void) | null) => {
    clearTermRef.current = fn;
  }, []);

  const clearTerminal = useCallback(async (id: string) => {
    if (clearTermRef.current) {
      clearTermRef.current();
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { sessions } = await api.shell.list();
      setTerminals(sessions ?? []);
      const cur = activeIdRef.current;
      if (cur && sessions && !sessions.some((s) => s.id === cur && s.alive)) {
        setActiveId(null);
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: load the session list and restore the previously active terminal.
  useEffect(() => {
    reload();
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setActiveId(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active project changes the list stays (sessions are global),
  // but we do a quick refresh in case cwd changed. Selection is preserved.
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (activeId) localStorage.setItem(STORAGE_KEY, activeId);
  }, [activeId]);

  const newTerminal = async () => {
    const cwd = project?.path ?? "";
    const baseName = `Terminal ${terminals.length + 1}`;
    try {
      const res = await api.shell.start({ cols: 80, rows: 24, cwd, name: baseName });
      // Refresh the list to pick up the new session metadata.
      await reload();
      setActiveId(res.id);
      localStorage.setItem(STORAGE_KEY, res.id);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      alert(e?.message ?? String(e));
    }
  };

  const handleOpen = (t: ShellSession) => {
    setActiveId(t.id);
    localStorage.setItem(STORAGE_KEY, t.id);
  };

  const removeTerminal = async (t: ShellSession) => {
    if (!confirm(`Stop terminal "${t.name || t.id.slice(0, 8)}"?`)) return;
    try {
      await api.shell.stop(t.id);
      if (activeId === t.id) {
        setActiveId(null);
        localStorage.removeItem(STORAGE_KEY);
      }
      await reload();
    } catch (e: any) {
      alert(e?.message ?? String(e));
    }
  };

  const stopTerminal = async (id: string) => {
    const t = terminals.find(x => x.id === id);
    if (!t) return;
    try {
      await api.shell.stop(id);
      if (activeId === id) {
        setActiveId(null);
        localStorage.removeItem(STORAGE_KEY);
      }
      await reload();
    } catch (e: any) {
      alert(e?.message ?? String(e));
    }
  };

  const startRename = (t: ShellSession) => {
    setRenaming(t);
    setRenameValue(t.name || "");
  };

  const commitRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name || name === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      await api.shell.rename(renaming.id, name);
      setTerminals((cur) => cur.map((x) => (x.id === renaming.id ? { ...x, name } : x)));
    } catch (e: any) {
      alert(e?.message ?? String(e));
    } finally {
      setRenaming(null);
    }
  };

  const back = () => {
    setActiveId(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  return {
    terminals,
    loading,
    error,
    activeId,
    renaming,
    renameValue,
    setRenameValue,
    setRenaming,
    reload,
    newTerminal,
    handleOpen,
    removeTerminal,
    stopTerminal,
    clearTerminal,
    setClearTermRef,
    startRename,
    commitRename,
    back,
  };
}
