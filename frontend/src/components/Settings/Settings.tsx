import { useEffect, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import type { Provider, Settings as SettingsType, UISettings, AISettings } from "../../types";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconChat, IconPlus, IconSettings, IconTrash, IconFiles, IconSearch, IconLogo, IconClose } from "../Icon";
import "./Settings.css";

const wrapOptions: DropdownOption[] = [
  { value: "on",  label: "On",  description: "Wrap long lines" },
  { value: "off", label: "Off", description: "Horizontal scroll" },
];
const minimapOptions: DropdownOption[] = [
  { value: "on",  label: "Show",   description: "Mini code overview" },
  { value: "off", label: "Hide",   description: "More editor space" },
];

export function SettingsPanel() {
  const { settings, loading, error, save, upsertProvider, deleteProvider, updateProviderModels, applyUI, applyAI } = useSettings();
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [saving, setSaving] = useState(false);

  // Keep the draft in sync as the canonical settings load/change so the
  // optimistic state always reflects the latest server value when the user
  // hasn't started editing.
  useEffect(() => {
    if (settings && !draft) setDraft(settings);
  }, [settings, draft]);

  if (loading && !draft) {
    return <div className="settings-page"><div className="sp-status">Loading…</div></div>;
  }
  const current = draft ?? settings;
  if (!current) return null;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings);

  const updateUI = (patch: Partial<UISettings>) => {
    applyUI(patch);
    setDraft((d) => d ? { ...d, ui: { ...d.ui, ...patch } } : d);
  };
  const updateAI = (patch: Partial<AISettings>) => {
    applyAI(patch);
    setDraft((d) => d ? { ...d, ai: { ...d.ai, ...patch } } : d);
  };

  const doSave = async () => {
    if (!draft) return;
    setSaving(true);
    try { await save(draft); setDraft(null); } finally { setSaving(false); }
  };

  const doSaveProvider = async (p: Provider) => {
    try { await upsertProvider(p); } catch (e: any) { alert(e.message); }
  };

  const doDelete = async (id: string) => {
    if (!confirm("Delete this provider?")) return;
    try { await deleteProvider(id); } catch (e: any) { alert(e.message); }
  };

  const addModel = async (providerId: string, name: string) => {
    if (!name.trim()) return;
    try { await updateProviderModels(providerId, name.trim(), "add"); }
    catch (e: any) { alert(e.message); }
  };

  const removeModel = async (providerId: string, name: string) => {
    try { await updateProviderModels(providerId, name, "remove"); }
    catch (e: any) { alert(e.message); }
  };

  const themeOptions: DropdownOption[] = [
    { value: "vs-dark",   label: "Dark",          description: "Monaco default dark" },
    { value: "vs-light",  label: "Light",         description: "Monaco light" },
    { value: "hc-black",  label: "High Contrast", description: "Monaco high-contrast" },
  ];

  const providerOptions: DropdownOption<string>[] = current.ai.providers.map((p) => ({
    value: p.id,
    label: p.name,
    description: p.baseUrl,
    icon: <IconChat size={14} />,
  }));

  return (
    <div className="settings-page">
      <header className="sp-header">
        <span className="sp-title row"><IconSettings /> Settings</span>
        {dirty && <span className="sp-unsaved">unsaved changes</span>}
      </header>

      {error && <div className="sp-error">{error}</div>}

      <div className="sp-scroll">
        <section className="sp-section">
          <h3 className="row"><IconLogo size={14} /> Editor</h3>
          <div className="sp-row">
            <Dropdown
              label="Theme"
              value={current.ui.theme}
              onChange={(v) => updateUI({ theme: v })}
              options={themeOptions}
            />
          </div>
          <div className="sp-row two">
            <label className="field">
              <span>Font size</span>
              <input type="number" min={8} max={32}
                value={current.ui.fontSize}
                onChange={(e) => updateUI({ fontSize: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Tab size</span>
              <input type="number" min={1} max={8}
                value={current.ui.tabSize}
                onChange={(e) => updateUI({ tabSize: Number(e.target.value) })} />
            </label>
          </div>
          <div className="sp-row two">
            <Dropdown
              label="Word wrap"
              value={current.ui.wordWrap ? "on" : "off"}
              onChange={(v) => updateUI({ wordWrap: v === "on" })}
              options={wrapOptions}
            />
            <Dropdown
              label="Minimap"
              value={current.ui.minimap ? "on" : "off"}
              onChange={(v) => updateUI({ minimap: v === "on" })}
              options={minimapOptions}
            />
          </div>
        </section>

        <section className="sp-section">
          <h3 className="row"><IconChat size={14} /> AI Providers</h3>
          <div className="sp-row">
            <Dropdown
              label="Default provider"
              value={current.ai.defaultProvider}
              onChange={(v) => updateAI({ defaultProvider: v })}
              options={providerOptions}
              placeholder="(no provider)"
            />
          </div>

          <div className="sp-provider-list">
            {current.ai.providers.map((p) => {
              return (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  onDraft={(patch) => setDraft((d) => d ? {
                    ...d,
                    ai: {
                      ...d.ai,
                      providers: d.ai.providers.map((x) => x.id === p.id ? { ...x, ...patch } : x),
                    },
                  } : d)}
                  onSave={() => doSaveProvider(
                    current.ai.providers.find((x) => x.id === p.id)!,
                  )}
                  onDelete={() => doDelete(p.id)}
                  onAddModel={(name) => addModel(p.id, name)}
                  onRemoveModel={(name) => removeModel(p.id, name)}
                />
              );
            })}
          </div>
        </section>

        <section className="sp-section">
          <h3 className="row"><IconFiles size={14} /> Workspace</h3>
          <p className="sp-help">Files opened from the Explorer load into the Editor page. The default workspace is resolved next to the kscode binary on launch.</p>
        </section>

        <section className="sp-section">
          <h3 className="row"><IconSearch size={14} /> Tips</h3>
          <ul className="sp-tips">
            <li>Click the hamburger on a phone to open the navigation drawer</li>
            <li>API keys can also be loaded from environment variables (e.g. <code>GEMINI_API_KEY</code>)</li>
            <li>Use <kbd>Ctrl/⌘ + S</kbd> in the Editor to save</li>
            <li>Use <kbd>Ctrl/⌘ + Enter</kbd> in the Chat to send</li>
          </ul>
        </section>
      </div>

      <footer className="sp-footer">
        <button className="btn btn-primary" onClick={doSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save Settings"}
        </button>
        <button className="btn btn-ghost" disabled={!dirty} onClick={() => setDraft(null)}>
          Discard
        </button>
      </footer>
    </div>
  );
}

function ProviderRow({
  provider,
  onDraft,
  onSave,
  onDelete,
  onAddModel,
  onRemoveModel,
}: {
  provider: Provider;
  onDraft: (patch: Partial<Provider>) => void;
  onSave: () => void;
  onDelete: () => void;
  onAddModel: (name: string) => void;
  onRemoveModel: (name: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const enabledOptions: DropdownOption[] = [
    { value: "true",  label: "Enabled" },
    { value: "false", label: "Disabled" },
  ];

  const submitModel = () => {
    if (!newModel.trim()) return;
    onAddModel(newModel.trim());
    setNewModel("");
  };

  return (
    <div className="provider-row">
      <div className="pr-top">
        <div className="pr-name">
          <strong>{provider.name}</strong>
          <span className="pr-id">{provider.id}</span>
        </div>
        <div className="spacer" />
        <Dropdown
          value={provider.enabled ? "true" : "false"}
          onChange={(v) => onDraft({ enabled: v === "true" })}
          options={enabledOptions}
          className="pr-enabled-dd"
        />
      </div>
      <div className="pr-fields">
        <label className="field">
          <span>Base URL</span>
          <input type="text" value={provider.baseUrl ?? ""}
            placeholder="https://api.example.com/v1"
            onChange={(e) => onDraft({ baseUrl: e.target.value })} />
        </label>
        <label className="field">
          <span>API key</span>
          <div className="pr-key">
            <input type={showKey ? "text" : "password"}
              value={provider.apiKey ?? ""}
              placeholder="paste API key"
              onChange={(e) => onDraft({ apiKey: e.target.value })} />
            <button className="btn" type="button" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "Hide" : "Show"}
            </button>
            <button className="btn btn-primary" type="button" onClick={onSave}>
              Save
            </button>
          </div>
        </label>
        <div className="pr-models">
          <span className="pr-models-title">Models</span>
          {provider.models && provider.models.length > 0 ? (
            <ul className="pr-model-list">
              {provider.models.map((m) => (
                <li key={m} className="pr-model-chip">
                  <span className="pr-model-name">{m}</span>
                  <button
                    className="pr-model-remove"
                    type="button"
                    title={`Remove ${m}`}
                    onClick={() => onRemoveModel(m)}
                  >
                    <IconClose size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pr-models-empty">No models configured yet.</p>
          )}
          <div className="pr-add-model">
            <input
              type="text"
              value={newModel}
              placeholder="e.g. gpt-4o"
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submitModel(); }
              }}
            />
            <button
              className="btn"
              type="button"
              onClick={submitModel}
              disabled={!newModel.trim()}
              title="Add model"
            >
              <IconPlus size={14} /> <span>Add</span>
            </button>
          </div>
        </div>
        {provider.note && <div className="pr-note">{provider.note}</div>}
      </div>
      <div className="pr-actions">
        <button className="pr-delete" onClick={onDelete}>
          <IconTrash size={14} /> <span>Remove provider</span>
        </button>
      </div>
    </div>
  );
}
