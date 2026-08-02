import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Provider, Settings, UISettings, AISettings } from "../types";

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tracks the most recent optimistic state so we can roll back on failure.
  const lastSavedRef = useRef<Settings | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.settings.get();
      setSettings(s);
      lastSavedRef.current = s;
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Optimistically update UI settings without waiting for the server.
  const applyUI = useCallback((patch: Partial<UISettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next: Settings = {
        ...prev,
        ui: { ...prev.ui, ...patch },
      };
      lastSavedRef.current = next;
      // Fire-and-forget persistence; roll back on failure.
      api.settings.save(next).catch((e) => {
        setError((cur) => cur ?? e.message ?? String(e));
        if (lastSavedRef.current) setSettings(lastSavedRef.current);
      });
      return next;
    });
  }, []);

  // Optimistically update AI settings (e.g. default provider).
  const applyAI = useCallback((patch: Partial<AISettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next: Settings = {
        ...prev,
        ai: { ...prev.ai, ...patch },
      };
      lastSavedRef.current = next;
      api.settings.save(next).catch((e) => {
        setError((cur) => cur ?? e.message ?? String(e));
        if (lastSavedRef.current) setSettings(lastSavedRef.current);
      });
      return next;
    });
  }, []);

  const save = useCallback(async (s: Settings) => {
    const updated = await api.settings.save(s);
    setSettings(updated);
    lastSavedRef.current = updated;
    return updated;
  }, []);

  const upsertProvider = useCallback(async (p: Provider) => {
    // Optimistic: merge the provider into local state immediately.
    setSettings((prev) => {
      if (!prev) return prev;
      const providers = prev.ai.providers.some((x) => x.id === p.id)
        ? prev.ai.providers.map((x) => (x.id === p.id ? { ...x, ...p } : x))
        : [...prev.ai.providers, p];
      const next: Settings = {
        ...prev,
        ai: { ...prev.ai, providers },
      };
      lastSavedRef.current = next;
      return next;
    });
    try {
      const updated = await api.settings.upsertProvider(p);
      setSettings(updated);
      lastSavedRef.current = updated;
      return updated;
    } catch (e: any) {
      setError(e.message ?? String(e));
      if (lastSavedRef.current) setSettings(lastSavedRef.current);
      throw e;
    }
  }, []);

  const deleteProvider = useCallback(async (id: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next: Settings = {
        ...prev,
        ai: { ...prev.ai, providers: prev.ai.providers.filter((x) => x.id !== id) },
      };
      lastSavedRef.current = next;
      return next;
    });
    try {
      const updated = await api.settings.deleteProvider(id);
      setSettings(updated);
      lastSavedRef.current = updated;
      return updated;
    } catch (e: any) {
      setError(e.message ?? String(e));
      if (lastSavedRef.current) setSettings(lastSavedRef.current);
      throw e;
    }
  }, []);

  const updateProviderModels = useCallback(
    async (id: string, model: string, action: "add" | "remove") => {
      const updated = await api.settings.updateProviderModels(id, model, action);
      setSettings(updated);
      lastSavedRef.current = updated;
      return updated;
    },
    [],
  );

  return {
    settings,
    loading,
    error,
    reload: load,
    save,
    upsertProvider,
    deleteProvider,
    updateProviderModels,
    applyUI,
    applyAI,
  };
}
