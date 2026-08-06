import type { Project } from "../../types";
import { useTerminals } from "../../hooks/useTerminals";
import { TerminalPanel } from "./Terminal";
import { IconClose, IconTerminal, IconStop, IconErase } from "../Icon";
import { useEffect } from "react";
import "../ChatsPanel/ChatsPanel.css";

interface Props {
  project: Project | null;
  terminalsApi: ReturnType<typeof useTerminals>;
}

/**
 * Main terminal area. Shows the selected terminal session; when nothing is
 * selected it shows an empty state pointing at the sidebar terminal list.
 */
export function TerminalsPanel({ project, terminalsApi }: Props) {
  const { terminals, activeId, back, stopTerminal, clearTerminal, setClearTermRef } = terminalsApi;
  const active = terminals.find((t) => t.id === activeId) ?? null;
  const cwd = project?.path ?? active?.cwd ?? "";

  // Register the clear function from the active terminal panel
  useEffect(() => {
    setClearTermRef(null);
  }, [setClearTermRef]);

  return (
    <div className="chats-panel">
      {active ? (
        <div className="chats-conversation">
          <div className="terminal-header-card">
            <button
              className="chats-convo-back icon-btn"
              onClick={back}
              title="Back to terminal list"
              aria-label="Back to terminal list"
            >
              <IconClose size={16} />
            </button>
            <div className="terminal-header-info">
              <span className="terminal-header-title" title={active.name || active.id}>
                {active.name || `Terminal ${active.id.slice(0, 4)}`}
              </span>
              <span className="terminal-header-status">
                connected ({active.id.slice(0, 8)})
              </span>
            </div>
            <div className="terminal-header-actions">
              <button className="btn btn-danger" onClick={() => stopTerminal(active.id)}>
                <IconStop size={14} /> <span className="hidden-mobile">Stop</span>
              </button>
              <button className="icon-btn" title="Clear" onClick={() => clearTerminal(active.id)}>
                <IconErase size={16} />
              </button>
            </div>
          </div>
          <div className="chats-conversation-body">
            {/* key by session id so each terminal gets a fresh xterm instance */}
            <TerminalPanel
              key={active.id}
              cwd={cwd}
              sessionId={active.id}
              autoStart
              onExit={() => terminalsApi.reload()}
              onRegisterClear={setClearTermRef}
            />
          </div>
        </div>
      ) : (
        <div className="chats-conversation">
          <div className="chats-conversation-body">
            <div className="chats-empty-state">
              <div className="chats-empty-icon"><IconTerminal size={28} /></div>
              <p className="chats-empty-title">No terminal selected</p>
              <p className="chats-empty-sub">
                Pick a terminal from the sidebar, or click <strong>New</strong> to open a shell.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
