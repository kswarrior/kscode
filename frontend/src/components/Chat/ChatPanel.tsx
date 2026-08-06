import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useChats } from "../../hooks/useChats";
import { useSettings } from "../../hooks/useSettings";
import type { AgentEvent, AgentRunRequest, ChatMessage, ChatMessageTool, Provider } from "../../types";
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
// Handles weak-model variants in addition to the canonical ```tool_call fence:
//   1. ```tool_call\n{json}\n```          (canonical fenced block)
//   2. ```json\n{name:..,args:..}\n```     (weak model that uses ```json)
//   3. ```\n{json}\n``` or ```tool\n..```  (bare/other-typed fence with tool JSON)
//   4. {tool_call}{json}{tool_call}        (inline opener)
//   5. bare `{tool_call}` markers
//   6. a bare JSON line {"name":"..","args":{..}}  (no fence at all)
const toolBlockRe = /```tool_call\s*\n[\s\S]*?\n```/g;
const genericFencedRe = /```[a-zA-Z0-9_+-]*\s*\n[\s\S]*?\n```/g;
const inlineToolCallRe = /\{tool_call\}\s*\{[\s\S]*?\}\s*\{tool_call\}/g;
const bareToolCallRe = /\{tool_call\}/g;
// Heuristic to detect a tool-call-shaped JSON blob's name key without a full
// parse: matches "name"|"tool"|"function" : "..." . Used by the bare-blob scan.
const bareToolNameRe = /"\s*(name|tool|function)"\s*:\s*"[^"]+"/;
// Kept for backwards compat with older persisted blobs that used the strict
// single-line shape; superseded by findBareToolJSON below.
const bareJSONToolRe = /^\s*\{"\s*(name|tool)"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}\s*$/gm;

// Brace/quote-aware scan that locates a complete {...} JSON object starting at
// index i. Handles nested objects/arrays AND escaped string contents (so a
// "content" arg containing "{" or "}" is not mistaken for JSON structure).
// Returns the full blob substring, or "" if none / unbalanced.
function findBareToolJSON(text: string, i: number): string {
  const n = text.length;
  while (i < n && text[i] !== "{") i++;
  if (i >= n) return "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  const start = i;
  for (; i < n; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    switch (c) {
      case '"':
        inStr = true;
        break;
      case "{":
      case "[":
        depth++;
        break;
      case "}":
      case "]":
        depth--;
        if (c === "}" && depth === 0) return text.slice(start, i + 1);
        if (depth < 0) return "";
        break;
    }
  }
  return "";
}

// Does a code-fence body (or bare blob) look like a tool call (name + args)?
// Mirrors backend. Two checks in order:
//   1. Strict JSON.parse — the common, well-formed case.
//   2. Lenient structural scan — handles "tool JSON" the model printed with
//      RAW control characters inside string values (literal newlines,
//      unescaped quotes inside content, etc.): the model frequently streams
//      multi-line file content with real \n instead of escaped \\n. Strict
//      JSON.parse rejects those, which caused the frontend to NOT recognize
//      the blob as a tool, leaving the raw JSON (and the quoted EJS content)
//      rendered as plain chat text — while the backend, which only needs the
//      name/path to execute the write, still created the file just fine.
//      The lenient path re-escapes obvious offenders and retries, and as a
//      last resort checks for the structural key shape so the span is still
//      paired with a tool card and stripped from the prose.
function fenceLooksLikeTool(body: string): boolean {
  if (looksLikeToolStrict(body)) return true;
  return looksLikeToolLenient(body);
}

function looksLikeToolStrict(body: string): boolean {
  try {
    const o = JSON.parse(body);
    return !!o && (typeof o === "object") && (!!o.name || !!o.tool || !!o.function);
  } catch {
    return false;
  }
}

// Lenient: even if the JSON won't parse (raw newlines in strings), recognize
// the shape {"(name|tool|function)":"...","args":{...}} . We scan with the
// brace-aware scanner so string contents don't fool us, and accept the blob
// if it has a (name|tool|function) key with a string value alongside any
// args/arguments/parameters/input key.
function looksLikeToolLenient(body: string): boolean {
  const s = body.trim();
  if (s[0] !== "{" || s[s.length - 1] !== "}") return false;
  let i = 0;
  const n = s.length;
  // skip leading {
  const next = (ch: string): RegExpMatchArray | null => {
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] !== ch) return null;
    i++;
    while (i < n && /\s/.test(s[i])) i++;
    return [""];
  };
  // Read a JSON string key (lenient: stops at unescaped closing quote).
  const readKey = (): string | null => {
    while (i < n && s[i] !== '"') i++;
    if (i >= n) return null;
    i++; // open quote
    let k = "";
    while (i < n) {
      if (s[i] === "\\") { k += s[i + 1] ?? ""; i += 2; continue; }
      if (s[i] === '"') { i++; break; }
      k += s[i++];
    }
    return k;
  };
  if (!next("{")) return false;
  let hasName = false, hasArgs = false;
  for (let pairs = 0; pairs < 50; pairs++) {
    const k = readKey();
    if (k === null) break;
    while (i < n && s[i] !== ":") i++;
    i++; // colon
    while (i < n && /\s/.test(s[i])) i++;
    // value: string, object, array, number, bool, null
    const vc = s[i];
    if (vc === '"') {
      // is it a name/tool/function key with a non-empty string value?
      let j = i + 1, v = "";
      while (j < n) {
        if (s[j] === "\\") { v += s[j + 1] ?? ""; j += 2; continue; }
        if (s[j] === '"') { j++; break; }
        v += s[j++];
      }
      if ((k === "name" || k === "tool" || k === "function") && v.length > 0) hasName = true;
      i = j;
    } else if (vc === "{" || vc === "[") {
      // skip a whole nested object/array using the brace scanner on the
      // remaining substring.
      const blob = findBareToolJSON(s, i);
      if (!blob) return false;
      if ((k === "args" || k === "arguments" || k === "parameters" || k === "input")) hasArgs = true;
      i += blob.length;
    } else {
      // number / true / false / null — skip token
      while (i < n && /[^\s,}\]]/.test(s[i])) i++;
    }
    // skip trailing comma / whitespace
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (s[i] === "}") break;
  }
  return hasName && hasArgs;
}

// Returns all [start, end] spans of text that are tool-call markers (any form),
// in the order they appear. Used by both stripToolBlocks and splitSegments.
function toolSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const push = (s: number, e: number) => { if (e > s) spans.push([s, e]); };
  let m: RegExpExecArray | null;

  const toolRe = new RegExp(toolBlockRe.source, "g");
  while ((m = toolRe.exec(text)) !== null) push(m.index, m.index + m[0].length);

  const genRe = new RegExp(genericFencedRe.source, "g");
  while ((m = genRe.exec(text)) !== null) {
    const inner = m[0].replace(/^```[a-zA-Z0-9_+-]*\s*\n/, "").replace(/\n```$/, "");
    if (fenceLooksLikeTool(inner)) push(m.index, m.index + m[0].length);
  }

  const inlineRe = new RegExp(inlineToolCallRe.source, "g");
  while ((m = inlineRe.exec(text)) !== null) push(m.index, m.index + m[0].length);

  // Bare inline JSON tool object ANYWHERE (not anchored to a line start) with
  // arbitrarily nested/multi-line args. A brace-aware scan rescues the common
  // weak-model case where the call is written mid-sentence or its args span
  // many lines (e.g. a long file content) — the old ^...$ regex silently
  // missed those, leaving the raw JSON rendered as text in the chat instead of
  // being collapsed into a tool card.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const blob = findBareToolJSON(text, i);
    if (!blob) continue;
    if (!fenceLooksLikeTool(blob)) continue;
    push(i, i + blob.length);
    i += blob.length - 1; // skip past interior so we don't re-scan it
  }

  // Sort FIRST, then drop spans nested inside an earlier (larger) one. The
  // dedup must run on sorted order — otherwise a fence found at index 95
  // (inserted before a bare JSON tool at index 22) would make the dedup
  // compare 22 < 95's-end and wrongly DROP the earlier-positioned tool,
  // leaking its raw JSON into the prose and desyncing every subsequent card
  // pairing (the "some cards okay, some merge with markdown" bug).
  spans.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < spans.length; k++) {
    if (k > 0 && spans[k][0] < spans[k - 1][1]) {
      spans.splice(k, 1);
      k--;
    }
  }
  return spans;
}

function stripToolBlocks(text: string): string {
  // Remove each tool span, then collapse leftover bare `{tool_call}` markers
  // and excess blank lines.
  const spans = toolSpans(text);
  let out = "";
  let last = 0;
  for (const [s, e] of spans) {
    if (s < last) continue; // skip overlapping spans (see splitSegments)
    out += text.slice(last, s);
    last = e;
  }
  out += text.slice(last);
  return out
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
  // Use the unified tool-span extractor so weak-model formats (```json,
  // bare JSON) split at the correct position too, not just ```tool_call.
  const spans = toolSpans(text);
  const segs: Segment[] = [];
  let lastIndex = 0;
  let toolIdx = 0;
  for (const [s, e] of spans) {
    // Skip spans that overlap the region already consumed (e.g. a fenced
    // ```tool_call block AND its detected inner JSON both produce spans at
    // overlapping indices). Overlap would pair the same tool twice.
    if (s < lastIndex) continue;
    const prose = text.slice(lastIndex, s);
    if (prose.replace(/\s/g, "")) {
      segs.push({ kind: "text", html: renderMarkdown(prose) });
    }
    if (toolIdx < tools.length) {
      segs.push({ kind: "tool", tool: tools[toolIdx++] });
    }
    lastIndex = e;
  }
  // Trailing prose after the last tool block, stripped of leftover markers.
  const tail = text.slice(lastIndex);
  const cleanTail = stripToolBlocks(tail);
  if (cleanTail.replace(/\s/g, "")) {
    segs.push({ kind: "text", html: renderMarkdown(cleanTail) });
  }
  // If no tool spans were embedded in the text but tools exist (e.g. they
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
    messages?: ChatMessage[];
    provider?: string;
    model?: string;
  };
  // Set when rendered from ChatsPanel so the composer can auto-create a chat
  // on the first prompt (instead of forcing the user to click "New chat").
  chatsApi?: ReturnType<typeof useChats>;
}

export function ChatPanel({ project, chat, chatsApi }: ChatPanelProps) {
  const { settings } = useSettings();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = settings?.ai.providers ?? [];
  const [providerId, setProviderId] = useState(settings?.ai.defaultProvider ?? "");
  // Persist the last-selected provider+model so reopening the app / opening a
  // brand-new chat shows the one you used last, instead of silently reverting
  // to the provider default. Stored as "<providerId>|<model>" (model may be
  // empty meaning "provider default, no specific model").
  const [modelKey, setModelKey] = useState<string>(() => {
    try {
      return localStorage.getItem("kscode:lastModelKey") ?? "";
    } catch {
      return "";
    }
  });
  // Step tracker: stepsTotal = number of tool_request events seen so far (the
  // agent's running "plan of N steps"); stepsDone = number of tool_result
  // events received. Shown next to the Send button as "Steps done/total" so
  // the user can watch progress even though the steps themselves render as
  // cards inline in the messages, not in a list.
  const [stepsTotal, setStepsTotal] = useState(0);
  const [stepsDone, setStepsDone] = useState(0);
  // Detailed step history for the expandable steps list. Each entry records
  // the tool name, short args summary, and result (ok/error) in the order
  // they were requested. Used when the user clicks the "Steps X/Y" pill to
  // show a dropdown like "1. write frontend, 2. write backend, 3. verify".
  const [stepHistory, setStepHistory] = useState<{
    id: string;
    name: string;
    argsSummary: string;
    ok?: boolean;
    output?: string;
  }[]>([]);
  const [showStepsList, setShowStepsList] = useState(false);
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

  const prevChatIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Don't kill any in-progress background task when SWITCHING chats or on a
    // page refresh — only tear down the LOCAL SSE stream. A subsequent
    // reconnect (reconnectToTask) rejoins the still-running task and replays
    // its buffered events, so refreshes don't lose the assistant output.
    //
    // Exception: the user EXPLICITLY navigated to a DIFFERENT chat while an
    // agent task for the previous chat is still running. In that case the
    // previous task belongs to a conversation we've left, so stop it on the
    // server (so it doesn't keep burning tokens in the background) before we
    // switch. On the very first mount (prevChatIdRef === null) we never stop.
    if (prevChatIdRef.current !== null && prevChatIdRef.current !== chat?.id) {
      stop();
    } else {
      abortLocal();
    }
    prevChatIdRef.current = chat?.id ?? null;
    setStepHistory([]);
    setError(null);
    if (chat?.messages && chat.messages.length > 0) {
      setMessages(
        chat.messages.map((m) => ({
          role: m.role,
          content: m.content,
          // Restore tool cards so they render again on reopen.
          tools: (m.tools ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            args: t.args,
            result: t.result ? { ok: t.result.ok, output: t.result.output } : undefined,
          })),
        })),
      );
    } else {
      setMessages([]);
    }
    if (chat?.provider) {
      // This chat remembers which provider+model it used — restore that.
      setProviderId(chat.provider);
      if (chat?.model) setModelKey(chat.provider + SEP + chat.model);
    } else {
      // No chat-specific model: fall back to the last one the user picked,
      // persisted across sessions in localStorage. If none was ever picked
      // (first run / cleared), leave modelKey empty so the dropdown shows the
      // "Select model" placeholder below.
      try {
        const last = localStorage.getItem("kscode:lastModelKey") ?? "";
        setModelKey(last);
        if (last) {
          const sepIdx = last.indexOf(SEP);
          if (sepIdx > -1) setProviderId(last.slice(0, sepIdx));
        }
      } catch { /* ignore */ }
    }
    // Reset the step counter when switching conversations.
    setStepsTotal(0);
    setStepsDone(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id]);

  // Reconnection: if there's a saved taskId and we have a chat, reconnect to the background task.
  // Re-runs when the saved task id changes or when a chat becomes selected
  // (e.g. restored asynchronously after a page refresh) so we don't miss the
  // window to rejoin a still-running agent task.
  useEffect(() => {
    if (!taskId || !chat) return;
    // If we already have an active assistant message, the task might still be running.
    // Check if we need to reconnect (no assistant message, or last one is still streaming).
    const hasActiveAssistant = messages.some(m => m.role === "assistant" && (m.streaming || m.thinking));
    if (!hasActiveAssistant) {
      // No active assistant - we might have missed the stream. Reconnect to get events.
      reconnectToTask();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, chat?.id]);

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
            if (ev.tool) {
              appendTool({ id: ev.tool.id, name: ev.tool.name, args: ev.tool.args });
              setStepsTotal((n) => n + 1);
            }
            // On reconnect the deltas are replayed, so last.content already
            // matches ev.text for this round. Resync the local accumulator only.
            if (ev.text) assistantText = ev.text;
            break;
          case "tool_result":
            if (ev.result) {
              updateToolResult(ev.result.id, { ok: ev.result.ok, output: ev.result.output });
              setStepsDone((n) => n + 1);
            }
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            assistantText = "";
            // Incrementally persist after each completed tool so a second
            // refresh (before done) still keeps the partial output + cards.
            if (chat) {
              try {
                setMessages((cur) => {
                  const last = cur[cur.length - 1];
                  if (last && last.role === "assistant") {
                    const tools: ChatMessageTool[] = (last.tools ?? []).map((t) => ({
                      id: t.id, name: t.name, args: t.args, result: t.result,
                    }));
                    void api.chats.upsert(project!.id, chat!.id, last.content, tools);
                  }
                  return cur;
                });
              } catch { /* ignore */ }
            }
            patchLastAssistant({ thinking: true });
            break;
          case "done":
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            patchLastAssistant({ thinking: false, streaming: false, retrying: null });
            setTaskId(null);
            setStepHistory([]);
            try { localStorage.removeItem("kscode:agentTaskId"); } catch { /* ignore */ }
            // Persist the completed turn in case the original send's finally
            // didn't run (e.g. page reloaded mid-task). Idempotent upsert.
            if (chat) {
              try {
                setMessages((cur) => {
                  const last = cur[cur.length - 1];
                  if (last && last.role === "assistant") {
                    const tools: ChatMessageTool[] = (last.tools ?? []).map((t) => ({
                      id: t.id, name: t.name, args: t.args, result: t.result,
                    }));
                    void api.chats.upsert(project!.id, chat!.id, last.content, tools);
                  }
                  return cur;
                });
              } catch { /* ignore */ }
            }
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
    // If the user has never picked a model in this chat (and there's no
    // persisted last-pick), prompt them to choose instead of silently showing
    // the provider's default model name.
    if (!effModel && !modelKey) return "Select model";
    if (!parsed.p) return "No provider";
    let label = parsed.p.name || parsed.p.id;
    if (parsed.model) label = parsed.model;
    return label;
  }, [parsed, effModel, modelKey]);

  const stop = async () => {
    abortLocal();
    // Also stop the background task on the server (only used by the Stop
    // button). Switching conversations / reloading must NOT call this — see
    // abortLocal() — because killing an in-progress background task on a
    // plain page refresh would discard the in-flight assistant output.
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

  // abortLocal tears down only the LOCAL SSE connection to the background
  // task, without telling the server to kill the task. Used when switching
  // chats (or when the component is re-mounting on a page refresh): the task
  // keeps running server-side, the new mount reconnects to it via the saved
  // taskId and replays buffered events, so nothing visible is lost.
  const abortLocal = () => {
    abortRef.current?.abort();
    abortRef.current = null;
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
    if (!pId || !effModel) {
      setError("Pick a model below.");
      return;
    }
    // Start this prompt's step counter at zero (the steps live on the
    // trailing assistant message, not across messages).
    setStepsTotal(0);
    setStepsDone(0);
    setStepHistory([]);
    // If no chat is selected (composer opened from "no chat selected" view),
    // auto-create one now so the first prompt materializes a chat that shows
    // up in the sidebar list immediately.
    let currentChat = chat;
    if (!currentChat && chatsApi && project) {
      const created = await chatsApi.ensureChat();
      if (!created) {
        setError("Could not create a chat.");
        return;
      }
      currentChat = created;
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

    if (currentChat) {
      try {
        await api.chats.append(project!.id, currentChat.id, "user", userText);
      } catch {
        /* best-effort persistence */
      }
    }

    // Persist the assistant turn ONCE at the end (idempotent upsert that
    // replaces the trailing assistant message instead of appending). We do
    // NOT save during streaming — that used to append a new assistant row on
    // every chunk, which caused the assistant text to show up multiple times
    // when the chat was reopened. The upsert is called once in the finally
    // block with the final content + tool cards.
    const persistTurn = async () => {
      if (!currentChat) return;
      try {
        // Read the last assistant message's content + tools from state
        // via a Promise that resolves after the state flush.
        const last = await new Promise<Msg | null>((resolve) =>
          setMessages((cur) => {
            const m = cur[cur.length - 1];
            resolve(m && m.role === "assistant" ? m : null);
            return cur;
          }),
        );
        if (!last) return;
        const tools: ChatMessageTool[] = (last.tools ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          args: t.args,
          result: t.result,
        }));
        await api.chats.upsert(project!.id, currentChat.id, last.content, tools);
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
            if (thinkTimerRef.current === null) {
              thinkTimerRef.current = setTimeout(() => {
                thinkTimerRef.current = null;
                patchLastAssistant({ thinking: false });
              }, 600);
            }
            break;
          case "tool_request":
            if (ev.tool) {
              const toolId = ev.tool.id;
              const name = ev.tool.name;
              const args = ev.tool.args ?? {};
              // Build a concise args summary for the steps list.
              const argsSummary = (() => {
                try {
                  const a = args;
                  if (Array.isArray(a.edits) && a.path) {
                    return `${a.path} (${a.edits.length} edit${a.edits.length === 1 ? "" : "s"})`;
                  }
                  if (name === "patch") {
                    const p = typeof a.patch === "string" ? a.patch : "";
                    const fileMatch = p.match(/^\+\+\+ b\/([^\s]+)/m);
                    return fileMatch ? `=> ${fileMatch[1]}` : "unified diff";
                  }
                  const keys = Object.keys(a);
                  const preferred = ["command", "path", "pattern", "from", "content", "old_string"];
                  for (const k of preferred) {
                    if (a[k] !== undefined) {
                      let v = String(a[k]);
                      if (v.length > 60) v = v.slice(0, 60) + "…";
                      return k === "command" ? v : k === "old_string" ? `→ ${a.path ?? ""}: ${v}` : `${k}: ${v}`;
                    }
                  }
                  if (keys.length) return JSON.stringify(a).slice(0, 60);
                  return "";
                } catch {
                  return "";
                }
              })();
              appendTool({ id: toolId, name, args });
              setStepsTotal((n) => n + 1);
              setStepHistory((prev) => [...prev, { id: toolId, name, argsSummary, ok: undefined, output: undefined }]);
            }
            if (ev.text) assistantText = ev.text;
            break;
          case "tool_result":
            if (ev.result) {
              updateToolResult(ev.result.id, { ok: ev.result.ok, output: ev.result.output });
              setStepsDone((n) => n + 1);
              setStepHistory((prev) => prev.map((s) => s.id === ev.result!.id ? { ...s, ok: ev.result!.ok, output: ev.result!.output } : s));
            }
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            assistantText = "";
            // Incrementally persist the assistant turn (so far) after every
            // completed tool. This way a page refresh MID-RUN still shows the
            // partial progress + cards from the saved chat, not just the user
            // message; the reconnect also fills in anything missing live.
            if (currentChat) void persistTurn();
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
            setStepHistory([]);
            if (currentChat) void persistTurn();
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
      // Finalize the assistant turn (no longer streaming / thinking).
      setMessages((cur) => {
        const copy = [...cur];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant") {
          const content = last.content || "(empty response)";
          copy[copy.length - 1] = { ...last, content, thinking: false, streaming: false };
        }
        return copy;
      });
      setBusy(false);
      abortRef.current = null;

      // Persist the assistant turn ONCE (idempotent upsert replaces the
      // trailing assistant message instead of appending a duplicate row
      // for every streamed chunk). Also carries the tool cards so they
      // render again when the chat is reopened.
      if (currentChat) {
        await persistTurn();
        try { await api.chats.meta(project!.id, currentChat.id, pId, effModel); } catch { /* ignore */ }
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
              const key = modelName ? pid + SEP + modelName : "";
              setProviderId(pid);
              setModelKey(key);
              try { localStorage.setItem("kscode:lastModelKey", key); } catch { /* ignore */ }
            }}
          />
          {busy ? (
            <div className="chat-send-right">
              {(stepsTotal > 0 || stepsDone > 0) && (
                <div className="steps-dropdown">
                  <span
                    className={showStepsList ? "steps-pill steps-pill-open" : "steps-pill"}
                    title="Tool calls completed / total"
                    onClick={() => setShowStepsList((v) => !v)}
                    onBlur={() => setShowStepsList(false)}
                  >
                    Steps {stepsDone}/{stepsTotal}
                    <IconChevronDown size={10} className={showStepsList ? "steps-chevron-open" : ""} />
                  </span>
                  {showStepsList && stepHistory.length > 0 && (
                    <div className="steps-dropdown-menu" role="menu">
                      {stepHistory.map((s, i) => (
                        <div key={s.id} className="steps-dropdown-item" role="menuitem">
                          <span className="steps-dd-num">{i + 1}.</span>
                          <span className="steps-dd-name">{s.name}</span>
                          {s.argsSummary && <span className="steps-dd-args">{s.argsSummary}</span>}
                          {s.ok !== undefined && (
                            <span className={"steps-dd-status " + (s.ok ? "ok" : "err")}>
                              {s.ok ? "✓" : "✗"}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button className="btn chat-send chat-stop" onClick={stop} title="Stop">
                <IconStop size={14} />
              </button>
            </div>
          ) : (
            <div className="chat-send-right">
              {(stepsTotal > 0 || stepsDone > 0) && (
                <div className="steps-dropdown">
                  <span
                    className={showStepsList ? "steps-pill steps-pill-open" : "steps-pill"}
                    title="Tool calls completed / total"
                    onClick={() => setShowStepsList((v) => !v)}
                    onBlur={() => setShowStepsList(false)}
                  >
                    Steps {stepsDone}/{stepsTotal}
                    <IconChevronDown size={10} className={showStepsList ? "steps-chevron-open" : ""} />
                  </span>
                  {showStepsList && stepHistory.length > 0 && (
                    <div className="steps-dropdown-menu" role="menu">
                      {stepHistory.map((s, i) => (
                        <div key={s.id} className="steps-dropdown-item" role="menuitem">
                          <span className="steps-dd-num">{i + 1}.</span>
                          <span className="steps-dd-name">{s.name}</span>
                          {s.argsSummary && <span className="steps-dd-args">{s.argsSummary}</span>}
                          {s.ok !== undefined && (
                            <span className={"steps-dd-status " + (s.ok ? "ok" : "err")}>
                              {s.ok ? "✓" : "✗"}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button
                className="btn btn-primary chat-send"
                onClick={send}
                disabled={!input.trim() || !effModel}
                title="Send"
              >
                <IconSend size={14} />
              </button>
            </div>
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
  const empty = !selectedModel && !selectedProviderId;
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
        className={"mp-trigger" + (empty ? " mp-trigger-empty" : "")}
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
