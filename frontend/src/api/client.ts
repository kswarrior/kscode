import type {
  FileEntry,
  FileContent,
  SearchResult,
  Settings,
  Provider,
  ShellStartResponse,
  ShellSession,
  ChatRequest,
  ChatResponse,
  Project,
  Chat,
  ChatMessageTool,
  AgentEvent,
  AgentRunRequest,
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

  projects: {
    list: () => req<{ projects: Project[] }>(`/projects`),
    add: (name: string, path: string, create?: boolean) =>
      req<Project>(`/projects`, {
        method: "POST",
        body: JSON.stringify({ name, path, create: !!create }),
      }),
    rename: (id: string, patch: { name?: string; path?: string; create?: boolean }) =>
      req<Project>(`/projects/rename`, {
        method: "POST",
        body: JSON.stringify({ id, ...patch }),
      }),
    remove: (id: string) =>
      req<{ projects: Project[] }>(`/projects/delete`, {
        method: "POST",
        body: JSON.stringify({ id }),
      }),
    active: () => req<{ project: Project | null }>(`/projects/active`),
    setActive: (id: string) =>
      req<Project>(`/projects/active`, {
        method: "POST",
        body: JSON.stringify({ id }),
      }),
  },

  chats: {
    list: (projectId: string) =>
      req<{ chats: Chat[] }>(`/chats?projectId=${encodeURIComponent(projectId)}`),
    one: (projectId: string, chatId: string) =>
      req<Chat>(`/chats/one?projectId=${encodeURIComponent(projectId)}&chatId=${encodeURIComponent(chatId)}`),
    create: (projectId: string) =>
      req<Chat>(`/chats/create`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
    rename: (projectId: string, chatId: string, title: string) =>
      req<Chat>(`/chats/rename`, {
        method: "POST",
        body: JSON.stringify({ projectId, chatId, title }),
      }),
    meta: (projectId: string, chatId: string, provider: string, model: string) =>
      req<Chat>(`/chats/meta`, {
        method: "POST",
        body: JSON.stringify({ projectId, chatId, provider, model }),
      }),
    append: (
      projectId: string,
      chatId: string,
      role: "user" | "assistant" | "system",
      content: string,
    ) =>
      req<Chat>(`/chats/append`, {
        method: "POST",
        body: JSON.stringify({ projectId, chatId, role, content }),
      }),
    upsert: (
      projectId: string,
      chatId: string,
      content: string,
      tools: ChatMessageTool[] = [],
    ) =>
      req<Chat>(`/chats/upsert`, {
        method: "POST",
        body: JSON.stringify({ projectId, chatId, content, tools }),
      }),
    remove: (projectId: string, chatId: string) =>
      req<{ chats: Chat[] }>(`/chats/delete`, {
        method: "POST",
        body: JSON.stringify({ projectId, chatId }),
      }),
  },

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
    download: (path: string) => `/files/download?path=${encodeURIComponent(path)}`,
    downloadZip: (path: string) => `/files/download-zip?path=${encodeURIComponent(path)}`,
    downloadProject: () => `/files/download-project`,
    upload: (path: string, file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      return fetch(`${BASE}/files/upload`, { method: "POST", body: formData }).then((res) => {
        if (!res.ok) throw new Error("Upload failed");
        return res.json();
      });
    },
    uploadUrl: (url: string, path: string) =>
      req<{ status: string; path: string }>(`/files/upload-url`, {
        method: "POST",
        body: JSON.stringify({ url, path }),
      }),
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
    start: (opts: { cols?: number; rows?: number; cwd?: string; shell?: string; name?: string }) =>
      req<ShellStartResponse>(`/shell/start`, {
        method: "POST",
        body: JSON.stringify(opts),
      }),
    wsUrl: (id: string) => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/api/shell/ws?id=${id}`;
    },
    list: () => req<{ sessions: ShellSession[] }>(`/shell/list`),
    stop: (id: string) =>
      req<{ ok: boolean }>(`/shell/stop`, {
        method: "POST",
        body: JSON.stringify({ id }),
      }),
    rename: (id: string, name: string) =>
      req<{ ok: boolean }>(`/shell/rename`, {
        method: "POST",
        body: JSON.stringify({ id, name }),
      }),
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

  agent: {
    // Start a background agent run. Returns a taskId that can be used
    // to stream events via streamEvents() and stop via stop().
    run: async (runReq: AgentRunRequest): Promise<string> => {
      const res = await fetch(`${BASE}/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runReq),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text)?.error) ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      const data = await res.json() as { taskId: string };
      return data.taskId;
    },

    // Stream events for a background task. If lastEventIdx is provided,
    // the server will replay events from that index (for reconnection).
    // Resolves when the task completes, stops, or errors.
    streamEvents: async (
      taskId: string,
      onEvent: (ev: AgentEvent) => void,
      opts?: { signal?: AbortSignal; lastEventIdx?: number },
    ): Promise<void> => {
      const qs = new URLSearchParams();
      qs.set("taskId", taskId);
      if (opts?.lastEventIdx !== undefined) {
        qs.set("lastEvent", String(opts.lastEventIdx));
      }
      const url = `${BASE}/agent/stream?${qs.toString()}`;
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
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
          let ev: AgentEvent;
          try { ev = JSON.parse(payload) as AgentEvent; } catch { continue; }
          if (ev.tag === "error" && ev.error) throw new Error(ev.error);
          onEvent(ev);
          if (ev.tag === "done" || ev.tag === "error") return;
        }
      }
    },

    // Stop a background task.
    stop: async (taskId: string): Promise<void> => {
      const res = await fetch(`${BASE}/agent/stop?taskId=${encodeURIComponent(taskId)}`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = (JSON.parse(text)?.error) ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
    },
  },
};
