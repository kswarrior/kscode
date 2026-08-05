import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useSettings } from "../../hooks/useSettings";
import type { AgentEvent, AgentRunRequest, Provider } from "../../types";
import {
  IconChevronDown,
  IconSearch,
  IconSend,
  IconSpinner,
  IconStop,
  IconTool,
} from "../Icon";
import { renderMarkdown } from "./markdown";
import "./ChatPanel.css";

interface ToolEntry {
  id: string;
  name: string;
  args: any;
  result?: { ok: boolean; output: string };
}

interface Msg {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
  thinking?: boolean;
  tools?: ToolEntry[];
  // Set when the model hit a transient upstream error and we're waiting
  // before retrying. Contains the attempt # and seconds to wait for display.
  retrying?: { attempt: number; secs: number; error: string } | null;
}

const SEP = "|";

// Strip tool-call markers from assistant text before rendering as markdown.
// Handles three forms the model might emit:
//   1. ```tool_call\n{json}\n```          (canonical fenced block)
//   2. {tool_call}{json}                  (inline opener without closing)
//   3. bare `{tool_call}` markers with no body
// Also strip any leaked JSON objects that contain "name" + "args" keys
// near a `{tool_call}` marker.
const toolBlockRe = /```tool_call\s*\n[\s\S]*?\n```/g;
const inlineToolCallRe = /\{tool_call\}\s*\{[\s\S]*?\}\s*\{tool_call\}/g;
const bareToolCallRe = /\{tool_call\}/g;
function stripToolBlocks(text: string): string {
  return text
    .replace(toolBlockRe, "")
    .replace(inlineToolCallRe, "")
    .replace(bareToolCallRe, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A renderable segment of an assistant turn: either a chunk of prose
// (already converted to HTML markdown) or an inline tool card placeholder.
type Segment =
  | { kind: "text"; html: string }
  | { kind: "tool"; tool: ToolEntry };

// Splits an assistant message body into an ordered list of prose + tool
// segments, so tool cards render INLINE at the exact spot the model wrote
// them (mirroring opencode / Claude Code) rather than in a stacked block
// above the text. The model emits tool calls in a deterministic order that
// matches the `tools` array we accumulate from tool_request events, so we
// pair each detected fence/inline marker with the corresponding tool.
function splitSegments(text: string, tools: ToolEntry[]): Segment[] {
  // ONE combined regex that matches fenced ```tool_call blocks OR inline
  // {tool_call}{...}{tool_call} markers, in the order they appear.
  const re = /```tool_call\s*\n[\s\S]*?\n```/g;
  const segs: Segment[] = [];
  let lastIndex = 0;
  let toolIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Prose before this tool block.
    const prose = text.slice(lastIndex, m.index);
    if (prose.replace(/\s/g, "")) {
      segs.push({ kind: "text", html: renderMarkdown(prose) });
    }
    // The tool card (paired by position; clamped to available tools).
    if (toolIdx < tools.length) {
      segs.push({ kind: "tool", tool: tools[toolIdx++] });
    }
    lastIndex = m.index + m[0].length;
  }
  // Trailing prose after the last tool block.
  const tail = text.slice(lastIndex);
  // Also strip any bare/inline tool_call markers that weren't real blocks.
  const cleanTail = tail.replace(inlineToolCallRe, "").replace(bareToolCallRe, "");
  if (cleanTail.replace(/\s/g, "")) {
    segs.push({ kind: "text", html: renderMarkdown(cleanTail.replace(/\n{3,}/g, "\n\n").trim()) });
  }
  // If no tool blocks were embedded in the text but tools exist (e.g. they
  // arrived as separate events without a fenced block in the stream), append
  // them at the end so they're still visible inline after the prose.
  while (toolIdx < tools.length) {
    segs.push({ kind: "tool", tool: tools[toolIdx++] });
  }
  return segs;
}

interface ChatPanelProps {
  project?: { id: string; name: string; path: string };
  chat?: {
    id: string;
    title: string;
    messages?: Msg[];
    provider?: string;
    model?: string;
  };
}

export function ChatPanel({ project, chat }: ChatPanelProps) {
  const { settings } = useSettings();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = settings?.ai.providers ?? [];
  const [providerId, setProviderId] = useState(settings?.ai.defaultProvider ?? "");
  const [modelKey, setModelKey] = useState<string>("");
  // Background task ID for reconnection support. Persisted in localStorage.
  const [taskId, setTaskId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("kscode:agentTaskId") ?? null;
    } catch {
      return null;
    }
  });
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const thinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    stop();
    setError(null);
    if (chat?.messages && chat.messages.length > 0) {
      setMessages(chat.messages.map((m) => ({ role: m.role, content: m.content })));
    } else {
      setMessages([]);
    }
    if (chat?.provider) setProviderId(chat.provider);
    if (chat?.model)
      setModelKey(chat.provider ? chat.provider + SEP + chat.model : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  // Reconnection: if there's a saved taskId and we have a chat, reconnect to the background task.
  useEffect(() => {
    if (!taskId || !chat) return;
    // If we already have an active assistant message, the task might still be running.
    // Check if we need to reconnect (no assistant message, or last one is still streaming).
    const hasActiveAssistant = messages.some(m => m.role === "assistant" && (m.streaming || m.thinking));
    if (!hasActiveAssistant) {
      // No active assistant - we might have missed the stream. Reconnect to get events.
      reconnectToTask();
    }
  }, []); // Run once on mount

  const reconnectToTask = async () => {
    if (!taskId || !chat) return;
    let assistantText = ""; // local accumulator for this reconnection
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    // We need to replay events from the beginning (lastEventIdx=0) to rebuild the state.
    // The server will send all past events then live events.
    try {
      await api.agent.streamEvents(taskId, (ev: AgentEvent) => {
        switch (ev.tag) {
          case "thinking":
            ensureAssistant();
            patchLastAssistant({ thinking: true, streaming: true });
            break;
          case "assistant_delta":
            if (!ev.delta) break;
            assistantText += ev.delta;
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = { ...last, content: last.content + ev.delta! };
              } else {
                // No assistant message yet - create one.
                copy.push({ role: "assistant", content: ev.delta!, streaming: true, thinking: false, tools: [] });
              }
              return copy;
            });
            if (thinkTimerRef.current === null) {
              thinkTimerRef.current = setTimeout(() => {
                thinkTimerRef.current = null;
                patchLastAssistant({ thinking: false });
              }, 600);
            }
            break;
          case "tool_request":
            if (ev.tool) appendTool({ id: ev.tool.id, name: ev.tool.name, args: ev.tool.args });
            break;
          case "tool_result":
            if (ev.result) updateToolResult(ev.result.id, { ok: ev.result.ok, output: ev.result.output });
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            assistantText = "";
            patchLastAssistant({ thinking: true });
            break;
          case "done":
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            patchLastAssistant({ thinking: false, streaming: false, retrying: null });
            setTaskId(null);
            try { localStorage.removeItem("kscode:agentTaskId"); } catch { /* ignore */ }
            break;
          case "retry":
            if (ev.attempt !== undefined && ev.delayMs !== undefined) {
              patchLastAssistant({
                retrying: { attempt: ev.attempt, secs: Math.ceil(ev.delayMs / 1000), error: ev.error ?? "" },
              });
            }
            break;
          case "error":
            if (ev.error) throw new Error(ev.error);
            break;
        }
      }, { signal: ac.signal, lastEventIdx: 0 });
    } catch (e: any) {
      const aborted = ac.signal.aborted;
      if (!aborted) setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [input]);

  const provider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  const parsed = useMemo(() => {
    if (!modelKey) return { p: provider, model: "" };
    const idx = modelKey.indexOf(SEP);
    if (idx === -1) return { p: provider, model: "" };
    return {
      p: providers.find((x) => x.id === modelKey.slice(0, idx)) ?? provider,
      model: modelKey.slice(idx + SEP.length),
    };
  }, [modelKey, provider, providers]);

  const effProviderId = parsed.p?.id ?? "";
  const effModel = parsed.model || "";

  useEffect(() => {
    if (!effProviderId && providers.length) setProviderId(providers[0].id);
  }, [effProviderId, providers]);

  const allProviders: Provider[] = providers.filter((p) => p.enabled);

  const modelsFor = (p: Provider): string[] => p.models ?? [];

  const triggerLabel = useMemo(() => {
    if (!parsed.p) return "No provider";
    let label = parsed.p.name || parsed.p.id;
    if (parsed.model) label = parsed.model;
    return label;
  }, [parsed]);

  const stop = async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Also stop the background task on the server.
    if (taskId) {
      try {
        await api.agent.stop(taskId);
      } catch {
        /* ignore */
      }
      setTaskId(null);
      try { localStorage.removeItem("kscode:agentTaskId"); } catch { /* ignore */ }
    }
  };

  // Ensure the last message is an assistant placeholder so thinking deltas can accumulate.
  const ensureAssistant = () => {
    setMessages((cur) => {
      const last = cur[cur.length - 1];
      if (last && last.role === "assistant") return cur;
      return [...cur, { role: "assistant", content: "", thinking: false, streaming: true, tools: [] }];
    });
  };

  // Mutate the last assistant message in state with a patch.
  const patchLastAssistant = (patch: Partial<Msg>) => {
    setMessages((cur) => {
      const copy = [...cur];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") {
        copy[copy.length - 1] = { ...last, ...patch };
      }
      return copy;
    });
  };

  const appendTool = (t: ToolEntry) => {
    setMessages((cur) => {
      const copy = [...cur];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") {
        const tools = [...(last.tools ?? []), t];
        copy[copy.length - 1] = { ...last, tools, thinking: false };
      }
      return copy;
    });
  };

  const updateToolResult = (id: string, result: { ok: boolean; output: string }) => {
    setMessages((cur) => {
      const copy = [...cur];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant" && last.tools) {
        const tools = last.tools.map((t) => (t.id === id ? { ...t, result } : t));
        copy[copy.length - 1] = { ...last, tools };
      }
      return copy;
    });
  };

  const send = async () => {
    if (!input.trim() || busy) return;
    const pId = effProviderId;
    if (!pId) {
      setError("Pick a model below.");
      return;
    }
    const userText = input.trim();
    const userMsg: Msg = { role: "user", content: userText };
    setMessages((cur) => [
      ...cur,
      userMsg,
      { role: "assistant", content: "", thinking: true, streaming: true, tools: [] },
    ]);
    setInput("");
    setError(null);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;

    // Build the conversation sent to the agent. Tool cards live in the UI
    // only; the model already saw tool results as user messages server-side.
    // Strip tool_call blocks from prior assistant messages so the model
    // doesn't re-encounter its own raw tool-call fences as context noise.
    const priorMessages = messages.map((m) => ({
      role: m.role,
      content: m.role === "assistant" ? stripToolBlocks(m.content) : m.content,
    })).filter((m) => m.content.length > 0);
    const agentMessages = [
      ...(project?.path
        ? [{
            role: "system",
            content: `Project: "${project.name}" at ${project.path}. Use this path to reason about file locations.`,
          }]
        : []),
      ...priorMessages,
      { role: "user", content: userText },
    ];

    const req: AgentRunRequest = {
      provider: pId,
      model: effModel || (parsed.p?.models?.[0] ?? ""),
      messages: agentMessages,
      maxRounds: 50,
    };

    if (chat) {
      try {
        await api.chats.append(project!.id, chat.id, "user", userText);
      } catch {
        /* best-effort persistence */
      }
    }

    let lastPersist = 0;
    const persistInterval = 800; // ms between incremental saves
    const persistAssistant = async (text: string, streaming = true) => {
      if (!chat) return;
      try {
        // Only persist periodically to avoid flooding the API
        const now = Date.now();
        if (!streaming || now - lastPersist >= persistInterval) {
          lastPersist = now;
          await api.chats.append(project!.id, chat.id, "assistant", text);
        }
      } catch {
        /* ignore */
      }
    };
    // Persist the full assistant message (content + tools) to chat history.
    const persistFullAssistant = async () => {
      if (!chat) return;
      try {
        setMessages((cur) => {
          const last = cur[cur.length - 1];
          if (last && last.role === "assistant") {
            // Fire-and-forget: we don't await this
            api.chats.append(project!.id, chat.id, "assistant", last.content);
          }
          return cur;
        });
      } catch {
        /* ignore */
      }
    };
    let assistantText = "";
    try {
      // Start (or reconnect to) a background task.
      let currentTaskId = taskId;
      if (!currentTaskId) {
        // No existing task - start a new one.
        currentTaskId = await api.agent.run(req);
        setTaskId(currentTaskId);
        try { localStorage.setItem("kscode:agentTaskId", currentTaskId); } catch { /* ignore */ }
      } else {
        // Reconnecting to existing task - the server will replay events.
        // The task is already running in the background.
      }

      // Stream events from the background task.
      await api.agent.streamEvents(currentTaskId, (ev: AgentEvent) => {
        switch (ev.tag) {
          case "thinking":
            ensureAssistant();
            patchLastAssistant({ thinking: true, streaming: true });
            break;
          case "assistant_delta":
            if (!ev.delta) break;
            assistantText += ev.delta;
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = {
                  ...last,
                  content: last.content + ev.delta!,
                };
              }
              return copy;
            });
            persistAssistant(assistantText, true);
            if (thinkTimerRef.current === null) {
              thinkTimerRef.current = setTimeout(() => {
                thinkTimerRef.current = null;
                patchLastAssistant({ thinking: false });
              }, 600);
            }
            break;
          case "tool_request":
            if (ev.tool) appendTool({ id: ev.tool.id, name: ev.tool.name, args: ev.tool.args });
            break;
          case "tool_result":
            if (ev.result) updateToolResult(ev.result.id, { ok: ev.result.ok, output: ev.result.output });
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            persistFullAssistant();
            assistantText = "";
            patchLastAssistant({ thinking: true });
            break;
          case "done":
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            patchLastAssistant({ thinking: false, streaming: false, retrying: null });
            // Task completed - clear the saved task ID so next prompt starts fresh
            setTaskId(null);
            try { localStorage.removeItem("kscode:agentTaskId"); } catch { /* ignore */ }
            break;
          case "retry":
            if (ev.attempt !== undefined && ev.delayMs !== undefined) {
              patchLastAssistant({
                retrying: { attempt: ev.attempt, secs: Math.ceil(ev.delayMs / 1000), error: ev.error ?? "" },
              });
            }
            break;
          case "error":
            if (ev.error) throw new Error(ev.error);
            break;
        }
      }, { signal: ac.signal });
    } catch (e: any) {
      const aborted = ac.signal.aborted;
      const msg = aborted ? "Stopped." : (e?.message ?? String(e));
      setError(aborted ? null : msg);
      setMessages((cur) => {
        const copy = [...cur];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") {
          copy[copy.length - 1] = {
            ...last,
            streaming: false,
            thinking: false,
            content: aborted
              ? last.content + "\n\n_(stopped)_"
              : (last.content ? last.content + "\n\n" : "") + `Error: ${msg}`,
          };
        }
        return copy;
      });
    } finally {
      // Clear any pending think-clear timer.
      if (thinkTimerRef.current) {
        clearTimeout(thinkTimerRef.current);
        thinkTimerRef.current = null;
      }
      // Finalize the assistant turn and persist the full text.
      let finalAssistant = "";
      setMessages((cur) => {
        const copy = [...cur];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") {
          finalAssistant = last.content || "(empty response)";
          copy[copy.length - 1] = { ...last, content: finalAssistant, thinking: false, streaming: false };
        }
        return copy;
      });
      setBusy(false);
      abortRef.current = null;

      if (chat && finalAssistant) {
        await persistAssistant(finalAssistant, false);
        try { await api.chats.meta(project!.id, chat.id, pId, effModel); } catch { /* ignore */ }
      }
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Start a conversation with the AI.</p>
          </div>
        )}
        {messages.map((m, i) => {
          const isAssistant = m.role === "assistant";
          const hasTools = isAssistant && m.tools && m.tools.length > 0;
          const segments = hasTools ? splitSegments(m.content, m.tools!) : null;
          const cursor = m.streaming && !m.thinking ? '<span class="chat-cursor">\u258B</span>' : "";
          return (
            <div key={i} className={"chat-msg chat-msg-" + m.role}>
              {hasTools && segments ? (
                <div className="chat-msg-body md-body md-inline-flow">
                  {segments.map((seg, si) =>
                    seg.kind === "text" ? (
                      <div
                        key={"t" + si}
                        className="md-seg"
                        dangerouslySetInnerHTML={{ __html: seg.html + (si === segments.length - 1 ? cursor : "") }}
                      />
                    ) : (
                      <ToolCard key={seg.tool.id} tool={seg.tool} />
                    ),
                  )}
                </div>
              ) : (
                <div
                  className="chat-msg-body md-body"
                  dangerouslySetInnerHTML={{
                    __html:
                      renderMarkdown(isAssistant ? stripToolBlocks(m.content) : m.content) + cursor,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Persistent bottom status bar: shows thinking / retrying state
          across ALL messages while the agent is working. Mirrors the
          "agent is working…" bar in opencode / Claude Code. */}
      {(busy || messages.some((m) => m.thinking || m.retrying)) && (
        <div className="agent-statusbar">
          {messages.some((m) => m.retrying) ? (
            (() => {
              const r = messages.find((m) => m.retrying)?.retrying;
              return r ? (
                <div className="statusbar-pill retrying-pill" aria-live="polite">
                  <IconSpinner size={13} className="icon-spin" />
                  <span>retrying in {r.secs}s (attempt {r.attempt})</span>
                </div>
              ) : null;
            })()
          ) : (
            <div className="statusbar-pill thinking-pill" aria-live="polite">
              <IconSpinner size={13} className="icon-spin" />
              <span>thinking…</span>
            </div>
          )}
        </div>
      )}

      {error && <div className="chat-error">{error}</div>}
      <div className="chat-input-wrap">
        <div className="chat-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Send a message… (⌘/Ctrl+Enter)"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
        </div>
        <div className="chat-send-wrap">
          <ModelPicker
            providers={allProviders}
            modelsFor={modelsFor}
            selectedProviderId={effProviderId}
            selectedModel={effModel}
            triggerLabel={triggerLabel}
            onPick={(pid, modelName) => {
              setProviderId(pid);
              setModelKey(modelName ? pid + SEP + modelName : "");
            }}
          />
          {busy ? (
            <button className="btn chat-send chat-stop" onClick={stop} title="Stop">
              <IconStop size={16} />
            </button>
          ) : (
            <button
              className="btn btn-primary chat-send"
              onClick={send}
              disabled={!input.trim()}
              title="Send"
            >
              <IconSend size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ModelPicker — grouped dropdown with search input and right-side
 * anchoring so it never clips off the phone screen.
 * ------------------------------------------------------------------ */
function ModelPicker({
  providers,
  modelsFor,
  selectedProviderId,
  selectedModel,
  triggerLabel,
  onPick,
}: {
  providers: Provider[];
  modelsFor: (p: Provider) => string[];
  selectedProviderId: string;
  selectedModel: string;
  triggerLabel: string;
  onPick: (providerId: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();

  return (
    <div className={open ? "mp mp-open" : "mp"} ref={wrapRef}>
      <button
        type="button"
        className="mp-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="mp-label">{triggerLabel}</span>
        <IconChevronDown size={13} />
      </button>
      {open && (
        <ul className="mp-menu glass-strong mp-menu-right" role="listbox">
          <li className="mp-search-row">
            <IconSearch size={13} className="mp-search-icon" />
            <input
              type="text"
              className="mp-search"
              placeholder="Search models..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </li>
          {providers.map((p) => {
            const models = modelsFor(p);
            const visibleModels = q
              ? models.filter((m) => m.toLowerCase().includes(q))
              : models;
            const provMatch = !q || p.name?.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
            if (!provMatch && visibleModels.length === 0) return null;
            const provDefaultSelected = p.id === selectedProviderId && selectedModel === "";

            if (q && visibleModels.length === 0 && !provMatch) return null;

            return (
              <li key={p.id} className="mp-group">
                {provMatch && (
                  <div
                    className={"mp-group-head" + (provDefaultSelected ? " mp-sel" : "")}
                    onClick={() => {
                      onPick(p.id, "");
                      setOpen(false);
                    }}
                    role="option"
                    aria-selected={provDefaultSelected}
                  >
                    <span className="mp-group-name">{p.name || p.id}</span>
                    {!q && <span className="mp-group-default">default</span>}
                  </div>
                )}
                {!q && visibleModels.length > 0 && (
                  <ul className="mp-models">
                    {models.map((m) => {
                      const sel = p.id === selectedProviderId && m === selectedModel;
                      return (
                        <li
                          key={m}
                          className={"mp-model" + (sel ? " mp-sel" : "")}
                          onClick={() => {
                            onPick(p.id, m);
                            setOpen(false);
                          }}
                          role="option"
                          aria-selected={sel}
                        >
                          {m}
                          {sel && (
                            <span className="mp-check" aria-hidden="true">
                              ✓
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {q &&
                  visibleModels.map((m) => {
                    const sel = p.id === selectedProviderId && m === selectedModel;
                    return (
                      <div
                        key={m}
                        className={"mp-model" + (sel ? " mp-sel" : "")}
                        onClick={() => {
                          onPick(p.id, m);
                          setOpen(false);
                        }}
                        role="option"
                        aria-selected={sel}
                      >
                        {m}
                        {sel && (
                          <span className="mp-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </div>
                    );
                  })}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ToolCard — collapsible card showing a tool's invocation + result.
 * ------------------------------------------------------------------ */
function ToolCard({ tool }: { tool: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const hasResult = !!tool.result;
  const argSummary = useMemo(() => {
    try {
      const a = tool.args ?? {};
      if (typeof a === "string") return a;
      // Tool-specific headline summaries.
      if (Array.isArray(a.edits) && a.path) {
        return `${a.path} (${a.edits.length} edit${a.edits.length === 1 ? "" : "s"})`;
      }
      if (tool.name === "patch") {
        const p = typeof a.patch === "string" ? a.patch : "";
        const fileMatch = p.match(/^\+\+\+ b\/([^\s]+)/m);
        return fileMatch ? `=> ${fileMatch[1]}` : "unified diff";
      }
      // Pick the most informative field for the headline.
      const keys = Object.keys(a);
      const preferred = ["command", "path", "pattern", "from", "content", "old_string"];
      for (const k of preferred) {
        if (a[k] !== undefined) {
          let v = String(a[k]);
          if (v.length > 80) v = v.slice(0, 80) + "…";
          return k === "command" ? v : k === "old_string" ? `→ ${a.path ?? ""}: ${v}` : `${k}: ${v}`;
        }
      }
      if (keys.length) return JSON.stringify(a).slice(0, 80);
      return "";
    } catch {
      return "";
    }
  }, [tool.args, tool.name]);

  return (
    <div className={"tool-card tool-card-" + (hasResult ? (tool.result?.ok ? "ok" : "err") : "pending")}>
      <button
        type="button"
        className="tc-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tc-icon"><IconTool size={13} /></span>
        <span className="tc-name">{tool.name}</span>
        {argSummary && <span className="tc-arg">{argSummary}</span>}
        <span className="tc-status">
          {!hasResult && <span className="tc-spin"><IconSpinner size={11} className="icon-spin" /></span>}
          {hasResult && (tool.result?.ok ? "done" : "error")}
        </span>
        <span className="tc-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tc-body">
          <div className="tc-section">
            <div className="tc-label">args</div>
            <pre className="tc-pre">{formatArgs(tool.args)}</pre>
          </div>
          {hasResult && (
            <div className="tc-section">
              <div className="tc-label">result</div>
              <pre className={"tc-pre" + (tool.result?.ok ? "" : " tc-pre-err")}>{tool.result?.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatArgs(args: any): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
