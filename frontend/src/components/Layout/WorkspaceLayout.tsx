import { useState } from "react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useSettings } from "../../hooks/useSettings";
import { FileTree } from "../FileTree/FileTree";
import { CodeEditor } from "../Editor/Editor";
import { TerminalPanel } from "../Terminal/Terminal";
import { SettingsPanel } from "../Settings/Settings";
import { ChatPanel } from "../Chat/ChatPanel";
import { SearchPanel } from "../Search/SearchPanel";
import "./WorkspaceLayout.css";

type SidebarTab = "explorer" | "search";

export function WorkspaceLayout() {
  const ws = useWorkspace();
  const { settings, reload: reloadSettings } = useSettings();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("explorer");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(true);

  const ui = settings?.ui ?? null;

  const handleOpen = (path: string) => setActivePath(path);

  const handleSearchOpen = (path: string, _line?: number) => {
    setActivePath(path);
    setSidebarTab("explorer");
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <span className="brand">KS Code</span>
        </div>
        <nav className="header-nav">
          <button className={sidebarOpen ? "active" : ""}
            onClick={() => setSidebarOpen((v) => !v)}>
            Explorer
          </button>
          <button onClick={() => setTerminalOpen((v) => !v)}>
            Terminal
          </button>
          <button onClick={() => setShowChat((v) => !v)}
            className={showChat ? "active" : ""}>
            AI Chat
          </button>
          <button onClick={() => setShowSettings((v) => !v)}
            className={showSettings ? "active" : ""}>
            Settings
          </button>
          <button onClick={() => { ws.refresh(); reloadSettings(); }}>
            Reload
          </button>
        </nav>
      </header>

      <div className="app-body">
        {sidebarOpen ? (
          <aside className="sidebar">
            <div className="sidebar-tabs">
              <button className={sidebarTab === "explorer" ? "active" : ""}
                onClick={() => setSidebarTab("explorer")}>
                Files
              </button>
              <button className={sidebarTab === "search" ? "active" : ""}
                onClick={() => setSidebarTab("search")}>
                Search
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
        ) : null}

        <main className="main-panel">
          <div className={"editor-area" + (terminalOpen ? " with-terminal" : "")}>
            <CodeEditor filePath={activePath} ui={ui} />
          </div>
          {terminalOpen ? (
            <div className="terminal-area">
              <TerminalPanel cwd={ws.root} fontSize={ui?.fontSize ?? 14} />
            </div>
          ) : null}
        </main>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showChat && <ChatPanel onClose={() => setShowChat(false)} />}
    </div>
  );
}
