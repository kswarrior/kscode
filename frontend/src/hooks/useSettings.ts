import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Provider, Settings } from "../types";

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.settings.get();
      setSettings(s);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (s: Settings) => {
    const updated = await api.settings.save(s);
    setSettings(updated);
    return updated;
  }, []);

  const upsertProvider = useCallback(async (p: Provider) => {
    const updated = await api.settings.upsertProvider(p);
    setSettings(updated);
    return updated;
  }, []);

  const deleteProvider = useCallback(async (id: string) => {
    const updated = await api.settings.deleteProvider(id);
    setSettings(updated);
    return updated;
  }, []);

  return { settings, loading, error, reload: load, save, upsertProvider, deleteProvider };
}
