import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size?: number): SVGProps<SVGSVGElement> => ({
  width: size ?? 18,
  height: size ?? 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

export function IconMenu(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <line x1="4" y1="7"  x2="20" y2="7"  />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
   </svg>
  );
}

export function IconFiles(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
   </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="20" y1="20" x2="16.5" y2="16.5" />
   </svg>
  );
}

export function IconChat(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2z" />
   </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
   </svg>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <polyline points="7,10 10,13 7,16" />
      <line x1="13" y1="16" x2="17" y2="16" />
   </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <polyline points="20,4 20,10 14,10" />
      <path d="M20 10A8 8 0 1 1 6.3 6.3" />
   </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
   </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
   </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <polyline points="4,7 20,7" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
   </svg>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M14 4l6 6-10 10H4v-6z" />
      <line x1="14" y1="4" x2="20" y2="10" />
   </svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14,3 14,8 19,8" />
   </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
   </svg>
  );
}

export function IconFolderOpen(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H5a2 2 0 0 0-2 2z" />
      <path d="M5 9h14l-2 9a2 2 0 0 1-2 2H5z" />
    </svg>
  );
}

export function IconProjects(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="8" height="7" rx="1.5" />
      <rect x="13" y="13" width="8" height="7" rx="1.5" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <polyline points="6,9 12,15 18,9" />
   </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <polyline points="9,6 15,12 9,18" />
   </svg>
  );
}

export function IconSave(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8l-4-4z" />
      <polyline points="15,4 15,8 9,8 9,4" />
      <rect x="7" y="12" width="10" height="6" />
   </svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <polygon points="7,5 19,12 7,19" />
   </svg>
  );
}

export function IconStop(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1" />
   </svg>
  );
}

export function IconErase(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M3 17l8-8 8 8-4 4H7z" />
      <line x1="9" y1="11" x2="15" y2="17" />
      <line x1="11" y1="9"  x2="17" y2="15" />
   </svg>
  );
}

export function IconSend(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M4 12l16-8-6 18-3-8z" />
    </svg>
  );
}

export function IconMoreVertical(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconSparkle(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8z" />
      <path d="M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7z" />
   </svg>
  );
}

export function IconLogo(props: IconProps) {
  return (
    <svg {...base(props.size ?? 22)} {...props}>
      <path d="M5 18L11 6l3 6 2-3 3 9" stroke="currentColor" strokeWidth="2.2" fill="none" />
      <circle cx="18.5" cy="6" r="1.6" fill="currentColor" />
   </svg>
  );
}

// Animated "thinking" spinner. The CSS animation lives in ChatPanel.css
// (.icon-spin). Use <IconSpinner /> inside a .thinking-pill for the
// animated "thinking..." indicator.
export function IconSpinner(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}

// Generic "tool" wrench icon for tool-call cards.
export function IconTool(props: IconProps) {
  return (
    <svg {...base(props.size)} {...props}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5.6 5.6 2 2 5.6-5.6a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2 2.4-2.4z" />
    </svg>
  );
}
