import type {
  FileEntry,
  FileContent,
  SearchResult,
  Settings,
  Provider,
  ShellStartResponse,
  ChatRequest,
  ChatResponse,
} from "../types";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!res.ok) {
    const msg = (body && body.error) ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  health: () => req<{ status: string }>(`/health`),

  files: {
    tree: (path = "/", depth = 8) =>
      req<{ root: string; entry: FileEntry }>(`/files/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
    read: (path: string) =>
      req<FileContent>(`/files/read?path=${encodeURIComponent(path)}`),
    write: (path: string, content: string) =>
      req<FileContent>(`/files/write`, {
        method: "POST",
        body: JSON.stringify({ path, content }),
      }),
    mkdir: (path: string) =>
      req<FileEntry>(`/files/mkdir`, {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    remove: (path: string) =>
      req<{ status: string }>(`/files/delete`, {
        method: "POST",
        body: JSON.stringify({ path }),
      }),
    rename: (oldPath: string, newPath: string) =>
      req<FileEntry>(`/files/rename`, {
        method: "POST",
        body: JSON.stringify({ oldPath, newPath }),
      }),
    search: (q: string) =>
      req<{ results: SearchResult[] }>(`/files/search?q=${encodeURIComponent(q)}`),
  },

  settings: {
    get: () => req<Settings>(`/settings`),
    save: (s: Settings) =>
      req<Settings>(`/settings`, { method: "POST", body: JSON.stringify(s) }),
    upsertProvider: (p: Provider) =>
      req<Settings>(`/settings/providers`, {
        method: "POST",
        body: JSON.stringify(p),
      }),
    deleteProvider: (id: string) =>
      req<Settings>(`/settings/providers/delete`, {
        method: "POST",
        body: JSON.stringify({ id }),
      }),
    updateProviderModels: (id: string, model: string, action: "add" | "remove") =>
      req<Settings>(`/settings/providers/models`, {
        method: "POST",
        body: JSON.stringify({ id, model, action }),
      }),
  },

  shell: {
    start: (opts: { cols?: number; rows?: number; cwd?: string; shell?: string }) =>
      req<ShellStartResponse>(`/shell/start`, {
        method: "POST",
        body: JSON.stringify(opts),
      }),
    wsUrl: (id: string) => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/api/shell/ws?id=${id}`;
    },
  },

  llm: {
    chat: (chatReq: ChatRequest) =>
      req<ChatResponse>("/llm/chat", { method: "POST", body: JSON.stringify(chatReq) }),
    // Streams a chat request via Server-Sent Events. onDelta is invoked for
    // each content chunk; onDone on completion; onError with an error message.
    stream: async (
      chatReq: ChatRequest,
      onDelta: (chunk: string) => void,
      opts?: { signal?: AbortSignal },
    ): Promise<void> => {
      const res = await fetch(`${BASE}/llm/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ ...chatReq, stream: true }),
        signal: opts?.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text)?.error) ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev: any;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.error) throw new Error(ev.error);
          if (ev.done) return;
          if (typeof ev.delta === "string" && ev.delta.length) onDelta(ev.delta);
        }
      }
    },
  },
};
