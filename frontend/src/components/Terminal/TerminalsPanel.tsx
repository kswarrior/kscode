import type { Project } from "../../types";
import { useTerminals } from "../../hooks/useTerminals";
import { TerminalPanel } from "./Terminal";
import { IconClose, IconTerminal } from "../Icon";
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
  const { terminals, activeId, back } = terminalsApi;
  const active = terminals.find((t) => t.id === activeId) ?? null;
  const cwd = project?.path ?? active?.cwd ?? "";

  return (
    <div className="chats-panel">
      {active ? (
        <div className="chats-conversation">
          <div className="chats-conversation-head">
            <button
              className="chats-convo-back icon-btn"
              onClick={back}
              title="Back to terminal list"
              aria-label="Back to terminal list"
            >
              <IconClose size={16} />
            </button>
            <span className="chats-convo-title" title={active.name || active.id}>
              {active.name || `Terminal ${active.id.slice(0, 4)}`}
            </span>
          </div>
          <div className="chats-conversation-body">
            {/* key by session id so each terminal gets a fresh xterm instance */}
            <TerminalPanel
              key={active.id}
              cwd={cwd}
              sessionId={active.id}
              autoStart
              onExit={() => terminalsApi.reload()}
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
