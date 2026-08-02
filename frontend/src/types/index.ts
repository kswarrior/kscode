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
