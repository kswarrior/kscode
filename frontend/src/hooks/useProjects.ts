import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Project } from "../types";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ projects }, { project }] = await Promise.all([
        api.projects.list(),
        api.projects.active(),
      ]);
      setProjects(projects ?? []);
      setActive(project ?? null);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const add = useCallback(async (name: string, path: string, create?: boolean) => {
    try {
      const p = await api.projects.add(name, path, create);
      // server returns the (possibly deduped) project; refetch list for canonical state.
      await reload();
      return p;
    } catch (e: any) {
      setError(e.message ?? String(e));
      throw e;
    }
  }, [reload]);

  const rename = useCallback(async (id: string, patch: { name?: string; path?: string; create?: boolean }) => {
    try {
      const p = await api.projects.rename(id, patch);
      await reload();
      return p;
    } catch (e: any) {
      setError(e.message ?? String(e));
      throw e;
    }
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    try {
      const { projects } = await api.projects.remove(id);
      setProjects(projects ?? []);
      // The server may have re-assigned active; re-fetch authoritative state.
      const { project } = await api.projects.active();
      setActive(project ?? null);
    } catch (e: any) {
      setError(e.message ?? String(e));
      throw e;
    }
  }, []);

  const open = useCallback(async (id: string) => {
    try {
      const p = await api.projects.setActive(id);
      setActive(p);
      return p;
    } catch (e: any) {
      setError(e.message ?? String(e));
      throw e;
    }
  }, []);

  return { projects, active, loading, error, reload, add, rename, remove, open };
}
