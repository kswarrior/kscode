import type { Project } from "../../types";
import { useChats } from "../../hooks/useChats";
import { ChatPanel } from "../Chat/ChatPanel";
import { IconClose, IconFolderOpen } from "../Icon";
import "./ChatsPanel.css";

interface Props {
  project: Project | null;
  chatsApi: ReturnType<typeof useChats>;
}

/**
 * Main chat area. Shows the open conversation; when nothing is selected it
 * shows an empty state pointing at the sidebar chat list.
 */
export function ChatsPanel({ project, chatsApi }: Props) {
  const { activeChat, back } = chatsApi;

  // When a project is active but no chat is selected, render the chat
  // composer directly (with an input box) instead of the "No chat selected"
  // empty state. The user's first prompt auto-creates a chat (see
  // useChats.ensureChat / ChatPanel.send) which then appears in the sidebar.
  if (!project) {
    return (
      <div className="chats-panel">
        <div className="chats-conversation">
          <div className="chats-conversation-body">
            <div className="chats-empty-state">
              <div className="chats-empty-icon"><IconFolderOpen size={28} /></div>
              <p className="chats-empty-title">No project selected</p>
              <p className="chats-empty-sub">
                Select a project from the header dropdown, then pick a chat from the sidebar.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chats-panel">
      <div className="chats-conversation">
        {activeChat && (
          <div className="chats-conversation-head">
            <button
              className="chats-convo-back icon-btn"
              onClick={back}
              title="Back to chat list"
              aria-label="Back to chat list"
            >
              <IconClose size={16} />
            </button>
            <span className="chats-convo-title" title={activeChat.title}>{activeChat.title || "Untitled"}</span>
          </div>
        )}
        <div className="chats-conversation-body">
          <ChatPanel
            project={{ id: project.id, name: project.name, path: project.path }}
            chat={activeChat ?? undefined}
            chatsApi={chatsApi}
          />
        </div>
      </div>
    </div>
  );
}
