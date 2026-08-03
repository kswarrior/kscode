import { useSyncExternalStore } from "react";
import { api } from "../api/client";
import type { Provider, Settings, AISettings, UISettings } from "../types";

// =====================================================================
// Module-level shared settings store. All components that call
// useSettings() share the SAME state, so when the Settings page saves a
// provider the Chat page immediately sees it without an extra reload.
// =====================================================================

type Listener = () => void;

interface State {
  settings: Settings | null;
  loading: boolean;
  error: string | null;
  lastSaved: Settings | null;
}

let state: State = { settings: null, loading: true, error: null, lastSaved: null };
const listeners = new Set<Listener>();
let initialized = false;

function emit() { for (const l of listeners) l(); }
function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function getSnapshot() { return state; }

async function load() {
  setState({ loading: true, error: null });
  try {
    const s = await api.settings.get();
    setState({ settings: s, lastSaved: s, loading: false });
  } catch (e: any) {
    setState({ error: e?.message ?? String(e), loading: false });
  }
}

function ensureInit() {
  if (initialized) return;
  initialized = true;
  load();
}

function applyUI(patch: Partial<UISettings>) {
  const prev = state.settings;
  if (!prev) return;
  const next: Settings = { ...prev, ui: { ...prev.ui, ...patch } };
  state = { ...state, settings: next, lastSaved: next };
  emit();
  api.settings.save(next).catch((e) => {
    setState({ error: state.error ?? e?.message ?? String(e) });
    if (state.lastSaved) state = { ...state, settings: state.lastSaved };
    emit();
  });
}

function applyAI(patch: Partial<AISettings>) {
  const prev = state.settings;
  if (!prev) return;
  const next: Settings = { ...prev, ai: { ...prev.ai, ...patch } };
  state = { ...state, settings: next, lastSaved: next };
  emit();
  api.settings.save(next).catch((e) => {
    setState({ error: state.error ?? e?.message ?? String(e) });
    if (state.lastSaved) state = { ...state, settings: state.lastSaved };
    emit();
  });
}

async function save(s: Settings) {
  const updated = await api.settings.save(s);
  setState({ settings: updated, lastSaved: updated });
  return updated;
}

async function upsertProvider(p: Provider) {
  const prev = state.settings;
  if (prev) {
    const providers = prev.ai.providers.some((x) => x.id === p.id)
      ? prev.ai.providers.map((x) => (x.id === p.id ? {
          ...x,
          ...p,
          models: p.models ?? x.models,
          apiKey: p.apiKey ?? x.apiKey,
        } : x))
      : [...prev.ai.providers, p];
    const next: Settings = { ...prev, ai: { ...prev.ai, providers } };
    setState({ settings: next, lastSaved: next });
  }
  try {
    const updated = await api.settings.upsertProvider(p);
    setState({ settings: updated, lastSaved: updated });
    return updated;
  } catch (e: any) {
    setState({ error: e?.message ?? String(e) });
    if (state.lastSaved) setState({ settings: state.lastSaved });
    throw e;
  }
}

async function deleteProvider(id: string) {
  const prev = state.settings;
  if (prev) {
    const next: Settings = {
      ...prev,
      ai: { ...prev.ai, providers: prev.ai.providers.filter((x) => x.id !== id) },
    };
    setState({ settings: next, lastSaved: next });
  }
  try {
    const updated = await api.settings.deleteProvider(id);
    setState({ settings: updated, lastSaved: updated });
    return updated;
  } catch (e: any) {
    setState({ error: e?.message ?? String(e) });
    if (state.lastSaved) setState({ settings: state.lastSaved });
    throw e;
  }
}

async function updateProviderModels(id: string, model: string, action: "add" | "remove") {
  const updated = await api.settings.updateProviderModels(id, model, action);
  setState({ settings: updated, lastSaved: updated });
  return updated;
}

export function useSettings() {
  ensureInit();
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return {
    settings: snap.settings,
    loading: snap.loading,
    error: snap.error,
    reload: load,
    save,
    upsertProvider,
    deleteProvider,
    updateProviderModels,
    applyUI,
    applyAI,
  };
}
