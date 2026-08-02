import { useEffect, useState } from "react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useSettings } from "../../hooks/useSettings";
import { FileTree } from "../FileTree/FileTree";
import { CodeEditor } from "../Editor/Editor";
import { TerminalPanel } from "../Terminal/Terminal";
import { SettingsPanel } from "../Settings/Settings";
import { ChatPanel } from "../Chat/ChatPanel";
import { SearchPanel } from "../Search/SearchPanel";
import {
  IconChat,
  IconClose,
  IconFiles,
  IconLogo,
  IconMenu,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTerminal,
} from "../Icon";
import "./WorkspaceLayout.css";

type SidebarTab = "explorer" | "search";
// Which "page" is shown in the main area. Header + sidebar persist across pages.
type MainPage = "editor" | "terminal" | "chat" | "settings";

export function WorkspaceLayout() {
  const ws = useWorkspace();
  const { settings, reload: reloadSettings } = useSettings();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Chat is the default page when the app opens.
  const [mainPage, setMainPage] = useState<MainPage>("chat");
  const [isMobile, setIsMobile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // responsive detection
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      const mobile = mql.matches;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
      else setSidebarOpen(true);
    };
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  // close mobile drawer on Escape
  useEffect(() => {
    if (!mobileNavOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNavOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [mobileNavOpen]);

  const ui = settings?.ui ?? null;
  const handleOpen = (path: string) => {
    setActivePath(path);
    setMainPage("editor");
    if (isMobile) setSidebarOpen(false);
  };
  const handleSearchOpen = (path: string) => {
    setActivePath(path);
    setSidebarTab("explorer");
    setMainPage("editor");
    if (isMobile) setSidebarOpen(false);
  };

  const onReload = () => { ws.refresh(); reloadSettings(); };
  const sidebarActive = sidebarOpen && (sidebarTab === "explorer" ? "explorer" : "search");

  return (
    <div className={"app-shell" + (isMobile && sidebarOpen ? " has-drawer" : "")}>
      <header className="app-header glass-strong">
        <button
          className="icon-btn hamburger visible-mobile"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
          title="Menu"
        >
          <IconMenu />
        </button>

        <div className="brand row">
          <IconLogo />
          <span className="brand-text">KS Code</span>
        </div>

        <nav className="header-nav">
          <button
            className={"icon-btn" + (mainPage === "chat" ? " active" : "")}
            onClick={() => setMainPage("chat")}
            aria-label="AI Chat"
            title="AI Chat"
          >
            <IconChat />
          </button>
          <button
            className={"icon-btn" + (mainPage === "terminal" ? " active" : "")}
            onClick={() => setMainPage("terminal")}
            aria-label="Terminal"
            title="Terminal"
          >
            <IconTerminal />
          </button>
          <button
            className={"icon-btn" + (mainPage === "editor" ? " active" : "")}
            onClick={() => setMainPage("editor")}
            aria-label="Editor"
            title="Editor"
          >
            <IconFiles />
          </button>
          <button
            className={"icon-btn" + (sidebarActive ? " active" : "")}
            onClick={() => { if (sidebarOpen) setSidebarOpen(false); else setSidebarOpen(true); }}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            <IconSearch />
          </button>
          <button
            className={"icon-btn" + (mainPage === "settings" ? " active" : "")}
            onClick={() => setMainPage("settings")}
            aria-label="Settings"
            title="Settings"
          >
            <IconSettings />
        </button>
          <button
            className="icon-btn"
            onClick={onReload}
            aria-label="Reload"
            title="Reload workspace"
          >
            <IconRefresh />
          </button>
        </nav>
      </header>

      {/* mobile nav drawer */}
      {isMobile && mobileNavOpen && (
        <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)}>
          <aside className="mobile-nav glass-strong" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-nav-head">
              <span className="gradient-text">Menu</span>
              <button
                className="icon-btn"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close"
              >
                <IconClose />
              </button>
            </div>
            <button className="mobile-nav-item" onClick={() => { setMainPage("chat"); setMobileNavOpen(false); }}>
              <IconChat /> <span>AI Chat</span>
            </button>
            <button className="mobile-nav-item" onClick={() => { setMainPage("terminal"); setMobileNavOpen(false); }}>
              <IconTerminal /> <span>Terminal</span>
            </button>
            <button className="mobile-nav-item" onClick={() => { setMainPage("editor"); setMobileNavOpen(false); }}>
              <IconFiles /> <span>Editor</span>
            </button>
            <button className="mobile-nav-item" onClick={() => { setSidebarOpen((v) => !v); setMobileNavOpen(false); }}>
              <IconSearch /> <span>{sidebarOpen ? "Hide" : "Show"} sidebar</span>
            </button>
            <button className="mobile-nav-item" onClick={() => { setMainPage("settings"); setMobileNavOpen(false); }}>
              <IconSettings /> <span>Settings</span>
           </button>
            <button className="mobile-nav-item" onClick={() => { onReload(); setMobileNavOpen(false); }}>
              <IconRefresh /> <span>Reload</span>
            </button>
          </aside>
        </div>
      )}

      <div className="app-body">
        {sidebarOpen && (
          <aside className={"sidebar glass" + (isMobile ? " as-drawer" : "")}>
            <div className="sidebar-tabs">
              <button
                className={sidebarTab === "explorer" ? "active" : ""}
                onClick={() => setSidebarTab("explorer")}
              >
                <IconFiles /> <span>Files</span>
              </button>
              <button
                className={sidebarTab === "search" ? "active" : ""}
                onClick={() => setSidebarTab("search")}
              >
                <IconSearch /> <span>Search</span>
              </button>
              <button
                className="sidebar-close icon-btn"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
                title="Close sidebar"
              >
                <IconClose size={14} />
              </button>
            </div>
            {sidebarTab === "explorer" ? (
              <FileTree
                entry={ws.tree}
                root={ws.root}
                loading={ws.loading}
                error={ws.error}
                onOpen={handleOpen}
                onRefresh={() => ws.refresh()}
              />
            ) : (
              <SearchPanel onOpen={handleSearchOpen} />
            )}
          </aside>
        )}

        <main className="main-panel">
          {/* All pages share the same header + sidebar; only main area swaps. */}
          {mainPage === "editor" && (
            <div className="page page-editor glass">
              <CodeEditor filePath={activePath} ui={ui} />
            </div>
          )}
          {mainPage === "terminal" && (
            <div className="page page-terminal glass">
              <TerminalPanel cwd={ws.root} fontSize={ui?.fontSize ?? 14} />
            </div>
          )}
          {mainPage === "chat" && (
            <div className="page page-chat glass">
              <ChatPanel />
         </div>
          )}
          {mainPage === "settings" && (
            <div className="page page-settings glass">
              <SettingsPanel />
         </div>
          )}
      </main>
    </div>
  </div>
  );
}
