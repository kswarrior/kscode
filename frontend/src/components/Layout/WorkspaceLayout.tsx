import { useEffect, useState } from "react";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useSettings } from "../../hooks/useSettings";
import { useProjects } from "../../hooks/useProjects";
import { useChats } from "../../hooks/useChats";
import { useTerminals } from "../../hooks/useTerminals";
import type { Project } from "../../types";
import { FileTree } from "../FileTree/FileTree";
import { CodeEditor } from "../Editor/Editor";
import { SettingsPanel } from "../Settings/Settings";
import { ChatsPanel } from "../ChatsPanel/ChatsPanel";
import { ChatsList } from "../ChatsPanel/ChatsList";
import { TerminalsPanel } from "../Terminal/TerminalsPanel";
import { TerminalsList } from "../Terminal/TerminalsList";
import { ProjectDropdownMenu } from "../ChatsPanel/ProjectDropdownMenu";
import { ProjectFormDialog } from "../ChatsPanel/ProjectFormDialog";
import {
  IconChat,
  IconClose,
  IconFiles,
  IconLogo,
  IconMenu,
  IconSettings,
  IconTerminal,
} from "../Icon";
import "./WorkspaceLayout.css";

// Which "page" is shown in the main area. Header + sidebar persist across pages.
type MainPage = "chat" | "editor" | "settings" | "terminal";

export function WorkspaceLayout() {
  const ws = useWorkspace();
  const { settings } = useSettings();
  const projects = useProjects();
  const chats = useChats(projects.active);
  const terminals = useTerminals(projects.active);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mainPage, setMainPage] = useState<MainPage>("chat");
  const [isMobile, setIsMobile] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);

  const handleDeleteProject = async (p: Project) => {
    if (!confirm(`Remove project "${p.name}"?\n(The on-disk files are NOT deleted.)`)) return;
    try {
      await projects.remove(p.id);
    } catch (e: any) {
      alert(e?.message ?? String(e));
    }
  };

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
    if (!sidebarOpen || !isMobile) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setSidebarOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [sidebarOpen, isMobile]);

  // When the active project changes, the backend FS root moves with it, so
  // re-fetch the file tree and clear the open file.
  useEffect(() => {
    setActivePath(null);
    ws.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.active?.id]);

  const ui = settings?.ui ?? null;
  const handleOpen = (path: string) => {
    setActivePath(path);
    setMainPage("editor");
    if (isMobile) setSidebarOpen(false);
  };
  const handleSearchOpen = (path: string) => {
    setActivePath(path);
    setMainPage("editor");
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <div className={"app-shell" + (isMobile && sidebarOpen ? " has-drawer" : "")}>
      <header className="app-header glass-strong">
        <button
          className="icon-btn hamburger"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="Toggle sidebar"
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          <IconMenu />
        </button>

        <div className="brand row">
          <IconLogo />
          <span className="brand-text">KS Code</span>
          <ProjectDropdownMenu
            projects={projects.projects}
            active={projects.active}
            onOpenProject={async (p) => {
              try {
                await projects.open(p.id);
              } catch (e: any) {
                alert(e?.message ?? String(e));
              }
            }}
            onAddProject={() => setAddProjectOpen(true)}
            onRename={(p) => setEditProject(p)}
            onEdit={(p) => setEditProject(p)}
            onDelete={handleDeleteProject}
          />
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
            className={"icon-btn" + (mainPage === "editor" ? " active" : "")}
            onClick={() => setMainPage("editor")}
            aria-label="Editor"
            title="Editor"
          >
            <IconFiles />
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
            className={"icon-btn" + (mainPage === "settings" ? " active" : "")}
            onClick={() => setMainPage("settings")}
            aria-label="Settings"
            title="Settings"
          >
            <IconSettings />
          </button>
        </nav>
      </header>

      <div className="app-body">
        {/* Sidebar content follows the open page: chat list on the Chat
            page, file explorer on the Editor page, none on Settings. */}
        {sidebarOpen && mainPage !== "settings" && (
          <aside className={"sidebar glass" + (isMobile ? " as-drawer" : "")}>
            {mainPage === "chat" ? (
              <ChatsList
                hasProjects={projects.projects.length > 0}
                active={projects.active}
                chatsApi={chats}
                onClose={() => setSidebarOpen(false)}
                onOpenChat={() => { if (isMobile) setSidebarOpen(false); }}
              />
            ) : mainPage === "terminal" ? (
              <TerminalsList
                active={terminals}
                onClose={() => setSidebarOpen(false)}
                onOpenTerminal={() => { if (isMobile) setSidebarOpen(false); }}
              />
            ) : (
              <FileTree
                entry={ws.tree}
                root={ws.root}
                loading={ws.loading}
                error={ws.error}
                onOpen={handleOpen}
                onRefresh={() => ws.refresh()}
              />
            )}
          </aside>
        )}

        <main className="main-panel">
          {/* All pages share the same header + sidebar; only main area swaps. */}
          {mainPage === "chat" && (
            <div className="page page-chat glass">
              <ChatsPanel project={projects.active} chatsApi={chats} />
            </div>
          )}
          {mainPage === "editor" && (
            <div className="page page-editor glass">
              <CodeEditor filePath={activePath} ui={ui} />
            </div>
          )}
          {mainPage === "terminal" && (
            <div className="page page-terminal glass">
              <TerminalsPanel project={projects.active} terminalsApi={terminals} />
            </div>
          )}
          {mainPage === "settings" && (
            <div className="page page-settings glass">
              <SettingsPanel />
            </div>
          )}
        </main>
      </div>

      {(addProjectOpen || editProject) && (
        <ProjectFormDialog
          mode={editProject ? "edit" : "add"}
          initial={editProject ?? undefined}
          onClose={() => { setAddProjectOpen(false); setEditProject(null); }}
          onSubmit={async (name, path, create) => {
            try {
              if (editProject) {
                await projects.rename(editProject.id, { name: name || undefined, path: path || undefined, create });
              } else {
                const p = await projects.add(name, path, create);
                await projects.open(p.id);
              }
              setAddProjectOpen(false);
              setEditProject(null);
            } catch (e: any) {
              throw e;
            }
          }}
        />
      )}
    </div>
  );
}
