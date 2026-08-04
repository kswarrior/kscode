import type { Project } from "../../types";
import { useChats } from "../../hooks/useChats";
import { ChatPanel } from "../Chat/ChatPanel";
import { IconChat, IconClose, IconFolderOpen } from "../Icon";
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

  return (
    <div className="chats-panel">
      {activeChat && project ? (
        <div className="chats-conversation">
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
          <div className="chats-conversation-body">
            <ChatPanel
              project={{ id: project.id, name: project.name, path: project.path }}
              chat={activeChat}
            />
          </div>
        </div>
      ) : (
        <div className="chats-conversation">
          <div className="chats-conversation-body">
            <div className="chats-empty-state">
              <div className="chats-empty-icon">{project ? <IconChat size={28} /> : <IconFolderOpen size={28} />}</div>
              <p className="chats-empty-title">{project ? "No chat selected" : "No project selected"}</p>
              <p className="chats-empty-sub">
                {project
                  ? "Pick a chat from the sidebar, or start a new one."
                  : "Select a project from the header dropdown, then pick a chat from the sidebar."}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
