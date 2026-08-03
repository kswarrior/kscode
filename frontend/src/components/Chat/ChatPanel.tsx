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
}

const SEP = "|";

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
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
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
    const priorMessages = messages.map((m) => ({ role: m.role, content: m.content }));
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
    };

    if (chat) {
      try {
        await api.chats.append(project!.id, chat.id, "user", userText);
      } catch {
        /* best-effort persistence */
      }
    }

    let assistantText = "";
    try {
      await api.agent.stream(req, (ev: AgentEvent) => {
        switch (ev.tag) {
          case "thinking":
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
                  thinking: false,
                  content: last.content + ev.delta!,
                };
              }
              return copy;
            });
            break;
          case "tool_request":
            if (ev.tool) appendTool({ id: ev.tool.id, name: ev.tool.name, args: ev.tool.args });
            break;
          case "tool_result":
            if (ev.result) updateToolResult(ev.result.id, { ok: ev.result.ok, output: ev.result.output });
            // New round: reset streaming text and show thinking again.
            assistantText = "";
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = { ...last, thinking: true, content: "" };
              }
              return copy;
            });
            break;
          case "done":
            patchLastAssistant({ thinking: false, streaming: false });
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
      // Finalize the assistant turn and (best-effort) persist its text.
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
        try { await api.chats.append(project!.id, chat.id, "assistant", finalAssistant); } catch { /* ignore */ }
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
        {messages.map((m, i) => (
          <div key={i} className={"chat-msg chat-msg-" + m.role}>
            {m.thinking && (
              <div className="thinking-pill" aria-live="polite">
                <IconSpinner size={13} className="icon-spin" />
                <span>thinking…</span>
              </div>
            )}
            {m.tools && m.tools.length > 0 && (
              <div className="tool-cards">
                {m.tools.map((t) => (
                  <ToolCard key={t.id} tool={t} />
                ))}
              </div>
            )}
            <div
              className="chat-msg-body md-body"
              dangerouslySetInnerHTML={{
                __html:
                  renderMarkdown(m.content) +
                  (m.streaming && !m.thinking ? '<span class="chat-cursor">\u258B</span>' : ""),
              }}
            />
          </div>
        ))}
      </div>
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
