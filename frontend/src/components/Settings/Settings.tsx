import { useEffect, useRef, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import type { Provider, Settings as SettingsType, UISettings } from "../../types";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { IconChat, IconPlus, IconSettings, IconTrash, IconLogo, IconClose, IconMoreVertical, IconSparkle, IconCheck, IconEdit } from "../Icon";
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
  const { settings, loading, error, upsertProvider, deleteProvider, applyUI } = useSettings();
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [showConnectDropdown, setShowConnectDropdown] = useState(false);
  const [customProvider, setCustomProvider] = useState<Partial<Provider>>({
    name: "",
    baseUrl: "",
    apiKey: "",
    models: [""],
  });
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const connectDropdownRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"general" | "providers">("general");

  // Sub-page editor for adding/editing providers. When open, the form is shown
  // instead of the provider list.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("add");

  // Keep the draft in sync with the canonical settings. We mirror the
  // providers list straight from settings (provider upserts bypass draft and
  // write to the shared store), while preserving any unsaved UI edits the
  // user has staged in the draft.
  useEffect(() => {
    setDraft((d) => {
      if (!settings) return d;
      if (!d) return settings;
      // Preserve user's UI changes, but always take the fresh providers from
      // the store (so upserts/deletes are reflected immediately).
      return { ui: d.ui, ai: settings.ai };
    });
  }, [settings]);

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
    return <div className="settings-page"><div className="sp-status">Loading\u2026</div></div>;
  }
  const current = draft ?? settings;
  if (!current) return null;
  // Only show providers the user has actually connected (enabled). The
  // backend ships default providers with enabled=false as connection
  // templates; until the user connects one, the Providers tab should show
  // the empty state rather than a list of disconnected placeholders.
  const connectedProviders = current.ai.providers.filter((p) => p.enabled);

  const updateUI = (patch: Partial<UISettings>) => {
    applyUI(patch);
    setDraft((d) => d ? { ...d, ui: { ...d.ui, ...patch } } : d);
  };

  const doSaveProvider = async (p: Provider) => {
    try { await upsertProvider(p); } catch (e: any) { alert(e.message); }
  };

  const doDelete = async (id: string) => {
    if (!confirm("Delete this provider?")) return;
    try { await deleteProvider(id); } catch (e: any) { alert(e.message); }
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
    setShowConnectDropdown(false);
    const existing = current.ai.providers.find((p) => p.id === provider.id);
    if (existing) {
      // Default provider already seeded (disabled). Open the editor with it
      // pre-filled AND force enabled:true so connecting actually connects —
      // otherwise the saved provider stays disabled and never shows up.
      setEditorMode("edit");
      setEditingProviderId(existing.id);
      setCustomProvider({ ...existing, enabled: true });
    } else {
      // Pre-fill with the known provider defaults and open the editor.
      setEditorMode("add");
      setEditingProviderId(null);
      setCustomProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: "",
        enabled: true,
        note: `Set ${provider.id.toUpperCase()}_API_KEY`,
        models: [],
      });
    }
    setEditorOpen(true);
  };

  const handleCustomConnect = () => {
    setShowConnectDropdown(false);
    setEditorMode("add");
    setEditingProviderId(null);
    setCustomProvider({ name: "", baseUrl: "", apiKey: "", models: [""] });
    setEditorOpen(true);
  };

  const handleSaveEditor = async () => {
    if (!customProvider.name?.trim() || !customProvider.baseUrl?.trim()) {
      alert("Name and Base URL are required");
      return;
    }
    const id = (customProvider.id ?? customProvider.name!.toLowerCase().replace(/\s+/g, "-"));
    const newProvider: Provider = {
      id,
      name: customProvider.name!,
      baseUrl: customProvider.baseUrl!,
      apiKey: customProvider.apiKey ?? "",
      enabled: customProvider.enabled ?? true,
      note: customProvider.note,
      models: customProvider.models?.filter((m) => m.trim()) ?? [],
    };
    try {
      await doSaveProvider(newProvider);
      setEditorOpen(false);
      setEditingProviderId(null);
      setCustomProvider({ name: "", baseUrl: "", apiKey: "", models: [""] });
    } catch (e: any) {
      alert(e.message);
    }
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingProviderId(null);
    setCustomProvider({ name: "", baseUrl: "", apiKey: "", models: [""] });
  };

  const handleEditProvider = (provider: Provider) => {
    setEditorMode("edit");
    setEditingProviderId(provider.id);
    setCustomProvider({ ...provider });
    setEditorOpen(true);
  };

  const handleDisconnect = (provider: Provider) => {
    const updated = { ...provider, enabled: false };
    doSaveProvider(updated);
  };

  return (
    <div className="settings-page">
      <header className="sp-header">
        <div className="sp-header-left">
          <span className="sp-title row"><IconSettings /> Settings</span>
          <nav className="sp-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "general"}
              className={`sp-tab${tab === "general" ? " active" : ""}`}
              onClick={() => setTab("general")}
            >
              General
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "providers"}
              className={`sp-tab${tab === "providers" ? " active" : ""}`}
              onClick={() => setTab("providers")}
            >
              Providers
            </button>
          </nav>
        </div>
      </header>

      {error && <div className="sp-error">{error}</div>}

      <div className="sp-scroll">
        {tab === "general" ? (
          <p className="sp-empty">No general settings yet.</p>
        ) : (
        <>
          <div className="sp-card-header">
            <h3 className="row"><IconChat size={14} /> Providers</h3>
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
                      {current.ai.providers.some((x) => x.id === p.id) && (
                        <IconCheck size={14} className="connect-check" />
                      )}
                    </li>
                  ))}
                  <li role="menuitem" className="connect-option custom" onClick={handleCustomConnect}>
                    <span className="connect-option-icon"><IconPlus size={14} /></span>
                    <span className="connect-option-label">Custom provider</span>
                  </li>
                </ul>
              )}
            </div>
          </div>

          <section className="sp-section ai-providers-section">
            {editorOpen ? (
              <ProviderEditor
                mode={editorMode}
                provider={customProvider}
                onChange={(patch) => setCustomProvider((prev) => ({ ...prev, ...patch }))}
                onSave={handleSaveEditor}
                onCancel={closeEditor}
                onAddModel={(name) => setCustomProvider((prev) => ({ ...prev, models: [...(prev.models ?? []), name] }))}
                onRemoveModel={(name) => setCustomProvider((prev) => ({ ...prev, models: (prev.models ?? []).filter((m) => m !== name) }))}
              />
            ) : (
              <div className="sp-provider-list">
                {connectedProviders.length === 0 && (
                  <p className="sp-providers-empty">
                    No providers connected yet. Click <strong>Connect</strong> to add one.
                  </p>
                )}
                {connectedProviders.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    onEdit={() => handleEditProvider(p)}
                    onDisconnect={() => handleDisconnect(p)}
                    onDelete={() => doDelete(p.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ProviderCard \u2014 simple card showing provider name + 3-dot menu.
 * ------------------------------------------------------------------ */
function ProviderCard({
  provider,
  onEdit,
  onDisconnect,
  onDelete,
}: {
  provider: Provider;
  onEdit: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="provider-card">
      <div className="pc-info">
        <span className="pc-name">{provider.name}</span>
        {!provider.enabled && <span className="pc-badge">disconnected</span>}
      </div>
      <div className="pc-menu" ref={menuRef}>
        <button className="icon-btn" onClick={() => setShowMenu(!showMenu)} aria-label="More options">
          <IconMoreVertical size={16} />
        </button>
        {showMenu && (
          <ul className="pc-menu-dropdown glass-strong" role="menu">
            <li role="menuitem" className="pc-menu-item" onClick={() => { onEdit(); setShowMenu(false); }}>
              <IconEdit size={14} /> Edit
            </li>
            <li role="menuitem" className="pc-menu-item" onClick={() => { onDisconnect(); setShowMenu(false); }}>
              <IconClose size={14} /> Disconnect
            </li>
            <li role="menuitem" className="pc-menu-item danger" onClick={() => { onDelete(); setShowMenu(false); }}>
              <IconTrash size={14} /> Delete
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ProviderEditor \u2014 sub-page form for adding/editing a provider with
 * name, base URL, API key, and models.
 * ------------------------------------------------------------------ */
function ProviderEditor({
  mode,
  provider,
  onChange,
  onSave,
  onCancel,
  onAddModel,
  onRemoveModel,
}: {
  mode: "add" | "edit";
  provider: Partial<Provider>;
  onChange: (patch: Partial<Provider>) => void;
  onSave: () => void;
  onCancel: () => void;
  onAddModel: (name: string) => void;
  onRemoveModel: (name: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");

  const submitModel = () => {
    if (!newModel.trim()) return;
    onAddModel(newModel.trim());
    setNewModel("");
  };

  const isAdd = mode === "add";

  return (
    <div className="provider-editor">
      <div className="pe-head">
        <span className="pe-title">{isAdd ? "Add Provider" : "Edit Provider"}</span>
        <button className="icon-btn pe-close" onClick={onCancel} aria-label="Close">
          <IconClose size={16} />
        </button>
      </div>
      <div className="pe-fields">
        <label className="field">
          <span>Name</span>
          <input type="text" value={provider.name ?? ""}
            placeholder="My Provider"
            onChange={(e) => onChange({ name: e.target.value })} />
        </label>
        <label className="field">
          <span>Base URL</span>
          <input type="text" value={provider.baseUrl ?? ""}
            placeholder="https://api.example.com/v1"
            onChange={(e) => onChange({ baseUrl: e.target.value })} />
        </label>
        <label className="field">
          <span>API Key</span>
          <div className="pe-key">
            <input type={showKey ? "text" : "password"}
              value={provider.apiKey ?? ""}
              placeholder="paste API key"
              onChange={(e) => onChange({ apiKey: e.target.value })} />
            <button className="btn" type="button" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <div className="field">
          <span>Models</span>
          {provider.models && provider.models.length > 0 ? (
            <ul className="pe-model-list">
              {provider.models.map((m) => (
                <li key={m} className="pe-model-chip">
                  <span>{m}</span>
                  <button className="pe-model-remove" type="button"
                    title={`Remove ${m}`}
                    onClick={() => onRemoveModel(m)}>
                    <IconClose size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pe-models-empty">No models configured yet.</p>
          )}
          <div className="pe-add-model">
            <input type="text" value={newModel}
              placeholder="e.g. gpt-4o"
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submitModel(); }
              }} />
            <button className="btn" type="button"
              onClick={submitModel}
              disabled={!newModel.trim()}
              title="Add model">
              <IconPlus size={14} /> <span>Add</span>
            </button>
          </div>
        </div>
      </div>
      <div className="pe-actions">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={onSave}>
          {isAdd ? "Add Provider" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}