import { useState } from "react";
import { api } from "../../api/client";
import { useSettings } from "../../hooks/useSettings";
import type { ChatRequest, ChatResponse } from "../../types";
import "./ChatPanel.css";

interface Msg { role: "user" | "assistant" | "system"; content: string; }

const KNOWN_MODELS: Record<string, string[]> = {
  gemini: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"],
  nvidia: ["meta/llama-3.1-70b-instruct", "meta/llama-3.3-70b-instruct", "mistralai/mixtral-8x7b-instruct-v0.1", "deepseek-ai/deepseek-r1"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
  anthropic: ["claude-3-5-sonnet-v2", "claude-3-5-haiku-v2"],
};

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { settings } = useSettings();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultProv = settings?.ai.defaultProvider ?? "gemini";
  const [provider, setProvider] = useState(defaultProv);
  const models = KNOWN_MODELS[provider] ?? [];
  const [model, setModel] = useState<string>("");

  const send = async () => {
    if (!input.trim()) return;
    const userMsg: Msg = { role: "user", content: input.trim() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setError(null);
    setBusy(true);
    try {
      const req: ChatRequest = {
        provider,
        model: model || (models.length > 0 ? models[0] : "default"),
        messages: next.map((m) => ({ role: m.role, content: m.content })),
      };
      const res: ChatResponse = await api.llm.chat(req);
      setMessages([...next, { role: "assistant", content: res.content || "(empty response)" }]);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setMessages([...next, { role: "assistant", content: `Error: ${e.message ?? String(e)}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">AI Chat</span>
        <button className="chat-clear" onClick={() => setMessages([])}>Clear</button>
        <button className="chat-close" onClick={onClose}>x</button>
      </div>
      <div className="chat-controls">
        <select value={provider} onChange={(e) => {
          setProvider(e.target.value);
          setModel("");
        }}>
          {(settings?.ai.providers ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">(default model)</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            Pick a provider, type a prompt. Keys are configured in Settings.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"chat-msg " + m.role}>
            <span className="chat-role">{m.role}</span>
            <pre className="chat-text">{m.content}</pre>
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><span className="chat-role">assistant</span><pre>...</pre></div>}
      </div>
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the model..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={busy || !input.trim()}>
          {busy ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
