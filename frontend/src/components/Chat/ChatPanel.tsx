import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useSettings } from "../../hooks/useSettings";
import type { ChatRequest, Provider } from "../../types";
import { IconChevronDown, IconSend, IconStop } from "../Icon";
import "./ChatPanel.css";

interface Msg { role: "user" | "assistant" | "system"; content: string; streaming?: boolean; }

const KNOWN_MODELS: Record<string, string[]> = {
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"],
  nvidia: ["meta/llama-3.1-70b-instruct", "meta/llama-3.3-70b-instruct", "mistralai/mixtral-8x7b-instruct-v0.1", "deepseek-ai/deepseek-r1"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
  anthropic: ["claude-3-5-sonnet-v2", "claude-3-5-haiku-v2"],
};

// "[providerId|modelName]" key for the model dropdown. empty => provider default.
const SEP = "|";

export function ChatPanel() {
  const { settings } = useSettings();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = settings?.ai.providers ?? [];
  const [providerId, setProviderId] = useState(settings?.ai.defaultProvider ?? "");
  const [modelKey, setModelKey] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const provider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  // Resolve the effective provider/model fields from the chosen dropdown key.
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

  // Build a flat list – but for rendering we group, so keep providers order.
  const allProviders: Provider[] = providers.length ? providers : [];
  function modelsFor(p: Provider): string[] {
    const known = KNOWN_MODELS[p.id] ?? [];
    return Array.from(new Set([...(p.models ?? []), ...known]));
  }

  // The trigger label shows the selected model name (or provider default).
  const triggerLabel = useMemo(() => {
    if (!parsed.p) return "No provider";
    let label = parsed.p.name || parsed.p.id;
    if (parsed.model) label = parsed.model;
    return label;
  }, [parsed]);

  const stop = () => { abortRef.current?.abort(); abortRef.current = null; };

  const send = async () => {
    if (!input.trim() || busy) return;
    const pId = effProviderId;
    if (!pId) { setError("Pick a model below."); return; }
    const userMsg: Msg = { role: "user", content: input.trim() };
    const sentMessages = [...messages, userMsg];
    setMessages([...sentMessages, { role: "assistant", content: "", streaming: true }]);
    setInput("");
    setError(null);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    const req: ChatRequest = {
      provider: pId,
      model: effModel || (parsed.p?.models?.[0] ?? ""),
      messages: sentMessages.map((m) => ({ role: m.role, content: m.content })),
    };
    try {
      await api.llm.stream(req, (chunk) => {
        setMessages((cur) => {
          const copy = [...cur];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + chunk };
          }
          return copy;
        });
      }, { signal: ac.signal });
      setMessages((cur) => {
        const copy = [...cur];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") {
          copy[copy.length - 1] = { ...last, streaming: false, content: last.content || "(empty response)" };
        }
        return copy;
      });
    } catch (e: any) {
      const aborted = ac.signal.aborted;
      const msg = aborted ? "Stopped." : (e?.message ?? String(e));
      setError(aborted ? null : msg);
      setMessages((cur) => {
        const copy = [...cur];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          copy[copy.length - 1] = {
            ...last, streaming: false,
            content: aborted ? (last.content + "\n\n_(stopped)_") : `Error: ${msg}`,
          };
        }
        return copy;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="chat-panel">
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
          {busy ? (
            <button className="btn chat-send chat-stop" onClick={stop} title="Stop">
              <IconStop size={16} />
            </button>
          ) : (
            <button className="btn btn-primary chat-send" onClick={send} disabled={!input.trim()} title="Send">
              <IconSend size={16} />
            </button>
          )}
        </div>
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
      </div>

      {/* Hidden render surface keeps stream accumulators alive; messages are
          intentionally not shown -- this is a headless composer as requested. */}
      <div className="chat-hidden">{messages.length}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ModelPicker — transparent, minimal-height grouped dropdown listing
 * each provider as a header followed by its models. Shows the chosen
 * model name in the toggle.
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
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
                  onClick={() => { onPick(p.id, ""); setOpen(false); }}
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
                          onClick={() => { onPick(p.id, m); setOpen(false); }}
                          role="option"
                          aria-selected={sel}
                        >
                          {m}
                          {sel && <span className="mp-check" aria-hidden="true">✓</span>}
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
