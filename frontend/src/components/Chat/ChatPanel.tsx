import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useSettings } from "../../hooks/useSettings";
import type { ChatRequest, Provider } from "../../types";
import { IconChevronDown, IconSend, IconStop } from "../Icon";
import "./ChatPanel.css";

interface Msg {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
}

const KNOWN_MODELS: Record<string, string[]> = {
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"],
  nvidia: [
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.3-70b-instruct",
    "mistralai/mixtral-8x7b-instruct-v0.1",
    "deepseek-ai/deepseek-r1",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
  anthropic: ["claude-3-5-sonnet-v2", "claude-3-5-haiku-v2"],
};

const SEP = "|";

interface ChatPanelProps {
  project?: { id: string; name: string; path: string };
  chat?: { id: string; title: string; messages?: Msg[]; provider?: string; model?: string };
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

  // Load chat history when chat changes (or reset when none).
  useEffect(() => {
    stop();
    setError(null);
    if (chat?.messages && chat.messages.length > 0) {
      setMessages(chat.messages.map((m) => ({ role: m.role, content: m.content })));
    } else {
      setMessages([]);
    }
    // Restore last-used provider/model for this chat if known.
    if (chat?.provider) setProviderId(chat.provider);
    if (chat?.model) setModelKey(chat.provider ? chat.provider + SEP + chat.model : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  // Keep messages scrolled to the bottom as they grow.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

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

  const allProviders: Provider[] = providers.filter(p => p.enabled);
  function modelsFor(p: Provider): string[] {
    return p.models ?? [];
  }

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

  const send = async () => {
    if (!input.trim() || busy) return;
    const pId = effProviderId;
    if (!pId) {
      setError("Pick a model below.");
      return;
    }
    const userText = input.trim();
    const userMsg: Msg = { role: "user", content: userText };
    const baseMessages: Msg[] = [];
    if (project?.path) {
      baseMessages.push({
        role: "system",
        content: `You are assisting inside the project "${project.name}" located at ${project.path}. Use this path to reason about file locations when relevant.`,
      });
    }
    const sentMessages = [...baseMessages, ...messages, userMsg];
    setMessages([...messages, userMsg, { role: "assistant", content: "", streaming: true }]);
    setInput("");
    setError(null);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    const req: ChatRequest = {
      provider: pId,
      model: effModel || (parsed.p?.models?.[0] ?? ""),
      messages: sentMessages
        .filter((m) => m.role !== "system" || baseMessages.includes(m))
        .map((m) => ({ role: m.role, content: m.content })),
    };

    // Persist the user turn if a chat is bound to this panel.
    if (chat) {
      try {
        await api.chats.append(project!.id, chat.id, "user", userText);
      } catch {
        /* best-effort persistence */
      }
    }

    let assistantText = "";
    try {
      try {
        // Try streaming first
        await api.llm.stream(req, (chunk) => {
          assistantText += chunk;
          setMessages((cur) => {
            const copy = [...cur];
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + chunk };
            }
            return copy;
          });
        }, { signal: ac.signal });
      } catch (streamErr: any) {
        // Fallback to non-streaming if streaming fails (e.g., "streaming not supported")
        const msg = streamErr?.message ?? String(streamErr);
        if (!ac.signal.aborted && msg.toLowerCase().includes("streaming not supported")) {
          try {
            const resp = await api.llm.chat(req);
            assistantText = resp.content;
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant" && last.streaming) {
                copy[copy.length - 1] = { ...last, streaming: false, content: assistantText || "(empty response)" };
              }
              return copy;
            });
          } catch (e: any) {
            throw e;
          }
        } else {
          throw streamErr;
        }
      }

      const finalText = assistantText || "(empty response)";
      setMessages((cur) => {
        const copy = [...cur];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") {
          copy[copy.length - 1] = { ...last, streaming: false, content: finalText };
        }
        return copy;
      });
      if (chat && finalText) {
        try {
          await api.chats.append(project!.id, chat.id, "assistant", finalText);
        } catch {
          /* ignore */
        }
        try {
          await api.chats.meta(project!.id, chat.id, pId, effModel);
        } catch {
          /* ignore */
        }
      }
    } catch (e: any) {
    const aborted = ac.signal.aborted;
    const msg = aborted ? "Stopped." : (e?.message ?? String(e));
    setError(aborted ? null : msg);
    setMessages((cur) => {
      const copy = [...cur];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        copy[copy.length - 1] = {
          ...last,
          streaming: false,
          content: aborted
            ? last.content + "\n\n_(stopped)_"
            : `Error: ${msg}`,
        };
      }
      return copy;
    });
    // Persist partial assistant turn even on error/abort.
    if (chat && assistantText) {
      try {
        await api.chats.append(project!.id, chat.id, "assistant", assistantText);
      } catch {
        /* ignore */
      }
    }
  } finally {
    setBusy(false);
    abortRef.current = null;
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
            <div className="chat-msg-role">{m.role}</div>
            <div className="chat-msg-body">
              {m.content}
              {m.streaming && <span className="chat-cursor">▋</span>}
            </div>
          </div>
        ))}
      </div>
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-input-wrap">
        <div className="chat-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Send a message…   (⌘/Ctrl+Enter)"
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
 * ModelPicker — transparent, minimal-height grouped dropdown listing
 * each provider as a header followed by its models.
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
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
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

  void SEP;

  return (
    <div className={"mp" + (open ? " mp-open" : "")} ref={wrapRef}>
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
        <ul className="mp-menu glass-strong" role="listbox">
          {providers.length === 0 && (
            <li className="mp-empty">No providers configured.</li>
          )}
          {providers.map((p) => {
            const models = modelsFor(p);
            const provDefaultSelected = p.id === selectedProviderId && selectedModel === "";
            return (
              <li key={p.id} className="mp-group">
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
                  <span className="mp-group-default">default</span>
                </div>
                {models.length > 0 && (
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
