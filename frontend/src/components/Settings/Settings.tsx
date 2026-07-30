import { useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import type { Provider, Settings as SettingsType } from "../../types";
import "./Settings.css";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, loading, error, save, upsertProvider, deleteProvider } = useSettings();
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [saving, setSaving] = useState(false);

  if (loading) return <div className="settings-panel"><div className="sp-status">Loading...</div></div>;

  const current = draft ?? settings;
  if (!current) return null;
  const dirty = draft !== null;

  const update = (patch: Partial<SettingsType>) => {
    setDraft({ ...current, ...patch });
  };
  const updateAI = (patch: Partial<SettingsType["ai"]>) => {
    setDraft({ ...current, ai: { ...current.ai, ...patch } });
  };
  const updateUI = (patch: Partial<SettingsType["ui"]>) => {
    setDraft({ ...current, ui: { ...current.ui, ...patch } });
  };
  const updateProvider = (id: string, patch: Partial<Provider>) => {
    updateAI({
      providers: current.ai.providers.map((p) => p.id === id ? { ...p, ...patch } : p),
    });
  };

  const doSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await save(draft);
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const doSaveProvider = async (p: Provider) => {
    try {
      await upsertProvider(p);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const doDelete = async (id: string) => {
    if (!confirm("Delete this provider?")) return;
    try { await deleteProvider(id); } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="settings-panel">
      <div className="sp-header">
        <span className="sp-title">Settings</span>
        <button className="sp-close" onClick={onClose}>x</button>
      </div>
      {error && <div className="sp-error">{error}</div>}
      <div className="sp-section">
        <h3>Editor</h3>
        <label>Theme
          <select value={current.ui.theme} onChange={(e) => updateUI({ theme: e.target.value })}>
            <option value="vs-dark">Dark</option>
            <option value="vs-light">Light</option>
            <option value="hc-black">High Contrast</option>
          </select>
        </label>
        <label>Font Size
          <input type="number" min={8} max={32} value={current.ui.fontSize}
            onChange={(e) => updateUI({ fontSize: Number(e.target.value) })} />
        </label>
        <label>Tab Size
          <input type="number" min={1} max={8} value={current.ui.tabSize}
            onChange={(e) => updateUI({ tabSize: Number(e.target.value) })} />
        </label>
        <label>Word Wrap
          <input type="checkbox" checked={current.ui.wordWrap}
            onChange={(e) => updateUI({ wordWrap: e.target.checked })} />
        </label>
        <label>Minimap
          <input type="checkbox" checked={current.ui.minimap}
            onChange={(e) => updateUI({ minimap: e.target.checked })} />
        </label>
      </div>

      <div className="sp-section">
        <h3>AI Providers</h3>
        <label>Default Provider
          <select value={current.ai.defaultProvider}
            onChange={(e) => updateAI({ defaultProvider: e.target.value })}>
            {current.ai.providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        {current.ai.providers.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            onChange={(patch) => updateProvider(p.id, patch)}
            onSave={() => doSaveProvider(
              current.ai.providers.find((x) => x.id === p.id)!,
            )}
            onDelete={() => doDelete(p.id)}
          />
        ))}
      </div>

      <div className="sp-footer">
        <button onClick={doSave} disabled={!dirty || saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {dirty && <span className="sp-unsaved">unsaved changes</span>}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  onChange,
  onSave,
  onDelete,
}: {
  provider: Provider;
  onChange: (patch: Partial<Provider>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div className="provider-row">
      <div className="pr-top">
        <strong>{provider.name}</strong>
        <span className={"pr-enabled" + (provider.enabled ? " on" : "")}>
          {provider.enabled ? "ON" : "OFF"}
        </span>
        <label className="pr-toggle">
          <input type="checkbox" checked={provider.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })} />
          enabled
        </label>
      </div>
      <div className="pr-fields">
        <label>Base URL
          <input type="text" value={provider.baseUrl ?? ""}
            placeholder="https://api.example.com/v1"
            onChange={(e) => onChange({ baseUrl: e.target.value })} />
        </label>
        <label>API Key
          <div className="pr-key">
            <input type={showKey ? "text" : "password"}
              value={provider.apiKey ?? ""}
              placeholder="paste API key"
              onChange={(e) => onChange({ apiKey: e.target.value })} />
            <button onClick={() => setShowKey((v) => !v)}>
              {showKey ? "hide" : "show"}
            </button>
            <button onClick={onSave}>Save Key</button>
          </div>
        </label>
        {provider.note && <div className="pr-note">{provider.note}</div>}
      </div>
      <div className="pr-actions">
        <button className="pr-delete" onClick={onDelete}>Remove provider</button>
      </div>
    </div>
  );
}
