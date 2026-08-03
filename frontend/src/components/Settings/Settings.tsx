import { useEffect, useRef, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import type { Provider, Settings as SettingsType, UISettings, AISettings } from "../../types";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconChat, IconPlus, IconSettings, IconTrash, IconFiles, IconSearch, IconLogo, IconClose, IconMoreVertical, IconSparkle, IconCheck, IconEdit } from "../Icon";
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
  const [showConnectDropdown, setShowConnectDropdown] = useState(false);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customProvider, setCustomProvider] = useState<Partial<Provider>>({
    name: "",
    baseUrl: "",
    apiKey: "",
    models: [""],
  });
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Provider>>({});
  const connectDropdownRef = useRef<HTMLDivElement>(null);

  // Keep the draft in sync as the canonical settings load/change so the
  // optimistic state always reflects the latest server value when the user
  // hasn't started editing.
  useEffect(() => {
    if (settings && !draft) setDraft(settings);
  }, [settings, draft]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (connectDropdownRef.current && !connectDropdownRef.current.contains(e.target as Node)) {
        setShowConnectDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

  const knownProviders = [
    { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", icon: <IconSparkle size={14} /> },
    { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", icon: <IconSparkle size={14} /> },
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", icon: <IconSparkle size={14} /> },
    { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", icon: <IconSparkle size={14} /> },
  ];

  const handleConnectProvider = (provider: typeof knownProviders[0]) => {
    const existing = current.ai.providers.find((p) => p.id === provider.id);
    if (existing) {
      setEditingProviderId(existing.id);
      setEditDraft({ ...existing });
      setShowConnectDropdown(false);
      return;
    }
    const newProvider: Provider = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      enabled: true,
      note: `Set ${provider.id.toUpperCase()}_API_KEY`,
      models: [],
    };
    doSaveProvider(newProvider);
    setShowConnectDropdown(false);
  };

  const handleCustomConnect = () => {
    setShowConnectDropdown(false);
    setShowCustomModal(true);
    setCustomProvider({ name: "", baseUrl: "", apiKey: "", models: [""] });
  };

  const handleSaveCustom = async () => {
    if (!customProvider.name?.trim() || !customProvider.baseUrl?.trim()) {
      alert("Name and Base URL are required");
      return;
    }
    const id = customProvider.name!.toLowerCase().replace(/\s+/g, "-");
    const newProvider: Provider = {
      id,
      name: customProvider.name!,
      baseUrl: customProvider.baseUrl!,
      apiKey: customProvider.apiKey ?? "",
      enabled: true,
      models: customProvider.models?.filter((m) => m.trim()) ?? [],
    };
    try {
      await doSaveProvider(newProvider);
      setShowCustomModal(false);
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleEditProvider = (provider: Provider) => {
    setEditingProviderId(provider.id);
    setEditDraft({ ...provider });
  };

  const handleSaveEdit = async (provider: Provider) => {
    const updated = { ...provider, ...editDraft };
    try {
      await doSaveProvider(updated);
      setEditingProviderId(null);
      setEditDraft({});
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleDisconnect = (provider: Provider) => {
    const updated = { ...provider, enabled: false };
    doSaveProvider(updated);
  };

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
          <div className="sp-row ai-providers-header">
            <Dropdown
              label="Default provider"
              value={current.ai.defaultProvider}
              onChange={(v) => updateAI({ defaultProvider: v })}
              options={providerOptions}
              placeholder="(no provider)"
            />
            <div className="connect-dropdown" ref={connectDropdownRef}>
              <button className="btn btn-primary" onClick={() => setShowConnectDropdown(!showConnectDropdown)}>
                <IconPlus size={14} /> Connect
              </button>
              {showConnectDropdown && (
                <ul className="connect-menu glass-strong" role="menu">
                  {knownProviders.map((p) => (
                    <li key={p.id} role="menuitem" className="connect-option" onClick={() => handleConnectProvider(p)}>
                      <span className="connect-option-icon">{p.icon}</span>
                      <span className="connect-option-label">{p.name}</span>
                      <span className="connect-option-desc">{p.baseUrl}</span>
                      {current.ai.providers.some((x) => x.id === p.id) && (
                        <IconCheck size={14} className="connect-check" />
                      )}
                    </li>
                  ))}
                  <li role="menuitem" className="connect-option custom" onClick={handleCustomConnect}>
                    <span className="connect-option-icon"><IconPlus size={14} /></span>
                    <span className="connect-option-label">Custom provider</span>
                    <span className="connect-option-desc">Add your own OpenAI-compatible endpoint</span>
                  </li>
                </ul>
              )}
            </div>
          </div>

          <div className="sp-provider-list">
            {current.ai.providers.map((p) => {
              const isEditing = editingProviderId === p.id;
              const draft = isEditing ? editDraft : {};
              return (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  isEditing={isEditing}
                  editDraft={draft}
                  onDraft={(patch) => {
                    if (isEditing) {
                      setEditDraft((prev) => ({ ...prev, ...patch }));
                    } else {
                      setDraft((d) => d ? {
                        ...d,
                        ai: {
                          ...d.ai,
                          providers: d.ai.providers.map((x) => x.id === p.id ? { ...x, ...patch } : x),
                        },
                      } : d);
                    }
                  }}
                  onSave={() => isEditing ? handleSaveEdit(p) : doSaveProvider(p)}
                  onEdit={() => handleEditProvider(p)}
                  onCancel={() => setEditingProviderId(null)}
                  onDisconnect={() => handleDisconnect(p)}
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
      <CustomProviderModal
        isOpen={showCustomModal}
        onClose={() => setShowCustomModal(false)}
        onSave={handleSaveCustom}
        provider={customProvider}
        onChange={setCustomProvider}
      />
    </div>
  );
}

function ProviderRow({
  provider,
  isEditing,
  editDraft,
  onDraft,
  onSave,
  onEdit,
  onCancel,
  onDisconnect,
  onDelete,
  onAddModel,
  onRemoveModel,
}: {
  provider: Provider;
  isEditing: boolean;
  editDraft: Partial<Provider>;
  onDraft: (patch: Partial<Provider>) => void;
  onSave: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
  onAddModel: (name: string) => void;
  onRemoveModel: (name: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const enabledOptions: DropdownOption[] = [
    { value: "true",  label: "Enabled" },
    { value: "false", label: "Disabled" },
  ];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const submitModel = () => {
    if (!newModel.trim()) return;
    onAddModel(newModel.trim());
    setNewModel("");
  };

  const displayProvider = { ...provider, ...editDraft };

  return (
    <div className={`provider-row ${isEditing ? "editing" : ""}`}>
      <div className="pr-top">
        <div className="pr-name">
          <strong>{displayProvider.name}</strong>
          <span className="pr-id">{displayProvider.id}</span>
        </div>
        <div className="spacer" />
        {!isEditing ? (
          <>
            <Dropdown
              value={displayProvider.enabled ? "true" : "false"}
              onChange={(v) => onDraft({ enabled: v === "true" })}
              options={enabledOptions}
              className="pr-enabled-dd"
            />
            <div className="pr-menu" ref={menuRef}>
              <button className="icon-btn" onClick={() => setShowMenu(!showMenu)} aria-label="More options">
                <IconMoreVertical size={14} />
              </button>
              {showMenu && (
                <ul className="pr-menu-dropdown glass-strong" role="menu">
                  <li role="menuitem" className="pr-menu-item" onClick={() => { onEdit(); setShowMenu(false); }}>
                    <IconEdit size={14} /> Edit
                  </li>
                  <li role="menuitem" className="pr-menu-item" onClick={() => { onDisconnect(); setShowMenu(false); }}>
                    <IconClose size={14} /> Disconnect
                  </li>
                  <li role="menuitem" className="pr-menu-item danger" onClick={() => { onDelete(); setShowMenu(false); }}>
                    <IconTrash size={14} /> Delete
                  </li>
                </ul>
              )}
            </div>
          </>
        ) : (
          <button className="btn btn-primary" onClick={onSave}>
            <IconCheck size={14} /> Save
          </button>
        )}
      </div>
      <div className="pr-fields">
        <label className="field">
          <span>Base URL</span>
          <input type="text" value={displayProvider.baseUrl ?? ""}
            placeholder="https://api.example.com/v1"
            onChange={(e) => onDraft({ baseUrl: e.target.value })} />
        </label>
        <label className="field">
          <span>API key</span>
          <div className="pr-key">
            <input type={showKey ? "text" : "password"}
              value={displayProvider.apiKey ?? ""}
              placeholder="paste API key"
              onChange={(e) => onDraft({ apiKey: e.target.value })} />
            <button className="btn" type="button" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "Hide" : "Show"}
            </button>
            {!isEditing && (
              <button className="btn btn-primary" type="button" onClick={onSave}>
                Save
              </button>
            )}
          </div>
        </label>
        <div className="pr-models">
          <span className="pr-models-title">Models</span>
          {displayProvider.models && displayProvider.models.length > 0 ? (
            <ul className="pr-model-list">
              {displayProvider.models.map((m) => (
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
        {displayProvider.note && <div className="pr-note">{displayProvider.note}</div>}
      </div>
      <div className="pr-actions">
        {isEditing && (
          <button className="pr-delete" onClick={onCancel}>
            <IconClose size={14} /> <span>Cancel</span>
          </button>
        )}
      </div>
    </div>
  );
}

function CustomProviderModal({ isOpen, onClose, onSave, provider, onChange }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  provider: Partial<Provider>;
  onChange: (patch: Partial<Provider>) => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass-strong" onClick={(e) => e.stopPropagation()}>
        <h3>Add Custom Provider</h3>
        <div className="modal-fields">
          <label className="field">
            <span>Name</span>
            <input type="text" value={provider.name ?? ""}
              placeholder="My Custom Provider"
              onChange={(e) => onChange({ name: e.target.value })} />
          </label>
          <label className="field">
            <span>Base URL</span>
            <input type="text" value={provider.baseUrl ?? ""}
              placeholder="https://api.example.com/v1"
              onChange={(e) => onChange({ baseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>API Key (optional)</span>
            <input type="password" value={provider.apiKey ?? ""}
              placeholder="sk-..."
              onChange={(e) => onChange({ apiKey: e.target.value })} />
          </label>
          <div className="field">
            <span>Models</span>
            {(provider.models ?? [""]).map((m, i) => (
              <div key={i} className="model-input-row">
                <input type="text" value={m}
                  placeholder={`Model ${i + 1} (e.g. gpt-4o)`}
                  onChange={(e) => {
                    const models = [...(provider.models ?? [""])];
                    models[i] = e.target.value;
                    onChange({ models });
                  }} />
                {(provider.models ?? [""]).length > 1 && (
                  <button className="btn" type="button" onClick={() => {
                    const models = (provider.models ?? [""]).filter((_, idx) => idx !== i);
                    onChange({ models });
                  }}>
                    <IconClose size={12} />
                  </button>
                )}
              </div>
            ))}
            <button className="btn" type="button" onClick={() => {
              onChange({ models: [...(provider.models ?? [""]), ""] });
            }}>
              <IconPlus size={14} /> Add Model
            </button>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Add Provider</button>
        </div>
      </div>
    </div>
  );
}
