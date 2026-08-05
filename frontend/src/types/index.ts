export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modTime: string;
  children?: FileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  modTime: string;
  language: string;
}

export interface SearchResult {
  path: string;
  line: number;
  preview: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  enabled: boolean;
  note?: string;
  models?: string[];
}

export interface AISettings {
  defaultProvider: string;
  providers: Provider[];
}

export interface UISettings {
  theme: string;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
}

export interface Settings {
  ai: AISettings;
  ui: UISettings;
}

export interface ShellEvent {
  type: string;
  stream?: string;
  data?: string;
  exit?: number;
  error?: string;
  cols?: number;
  rows?: number;
  pid?: number;
  started?: string;
  ended?: string;
}

export interface ShellStartResponse {
  id: string;
  pid: number;
  cwd: string;
}

export interface ShellSession {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  alive: boolean;
}

export interface ChatRequest {
  provider: string;
  model: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatResponse {
  provider: string;
  model: string;
  content: string;
  raw?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  messages?: ChatMessage[];
}

// ----- Agentic streaming ( /api/agent/run SSE ) -----
export interface AgentToolCall {
  id: string;
  name: string;
  args: any;
}

export interface AgentToolResult {
  id: string;
  name: string;
  ok: boolean;
  output: string;
}

export type AgentEventTag =
  | "thinking"
  | "assistant_delta"
  | "tool_request"
  | "tool_result"
  | "retry"
  | "done"
  | "error";

export interface AgentEvent {
  tag: AgentEventTag;
  round?: number;
  delta?: string;
  text?: string;
  tool?: AgentToolCall;
  result?: AgentToolResult;
  error?: string;
  attempt?: number;
  delayMs?: number;
}

export interface AgentRunRequest {
  provider: string;
  model: string;
  messages: { role: string; content: string }[];
  maxRounds?: number;
  system?: string;
  cwd?: string;
}
