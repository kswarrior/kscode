// Package agent implements a prompt-based agentic loop: a model streams
// assistant text that may contain fenced ```tool_call blocks. The runner
// parses those blocks, executes the requested tool via tools.Manager,
// feeds the result back into the conversation, and re-prompts the model
// until no more tool calls are emitted (or the round cap is hit).
//
// Events are delivered through the onEvent callback so the SSE handler
// can stream them straight to the browser. This is provider-agnostic:
// tool "calls" are just specially tagged fenced code blocks, so the same
// loop works with any LLM (Gemini, NVIDIA NIM, OpenAI, Anthropic...).
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"kscode/internal/llm"
	"kscode/internal/tools"
)

// EventTag identifies the kind of SSE event being emitted.
type EventTag string

const (
	EventThinking       EventTag = "thinking"        // the model is working (before a round)
	EventAssistantDelta EventTag = "assistant_delta" // streamed text chunk
	EventToolRequest    EventTag = "tool_request"    // a parsed tool call
	EventToolResult     EventTag = "tool_result"     // the tool's result
	EventRetry          EventTag = "retry"           // transient error; retrying after a delay
	EventDone           EventTag = "done"            // run finished cleanly
	EventError          EventTag = "error"           // failure
)

// Event is one streamed event. Only fields relevant to Tag are populated.
type Event struct {
	Tag   EventTag       `json:"tag"`
	Round int            `json:"round,omitempty"`
	Delta string         `json:"delta,omitempty"`
	Text  string         `json:"text,omitempty"` // full assistant text for the round
	Tool  *ToolCall      `json:"tool,omitempty"`
	Result *ToolResult   `json:"result,omitempty"`
	Error string         `json:"error,omitempty"`

	// Retry-specific fields for EventRetry:
	// Attempt = which retry this is (1, 2, 3...)
	// DelayMs = how long we'll wait before retrying (1000, 2000, 4000...)
	// Last = the underlying error message that triggered the retry.
	Attempt int    `json:"attempt,omitempty"`
	DelayMs int    `json:"delayMs,omitempty"`
}

// ToolCall is a parsed tool invocation. ID is a short round-unique label
// so the UI can render a card.
type ToolCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

// ToolResult carries the outcome of a single tool call.
type ToolResult struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

// RunConfig controls a run.
type RunConfig struct {
	Provider string
	Model    string
	System   string // system prompt (falls back to SystemPrompt)
	Cwd      string // project path used by tools (and shell cwd)
	Messages []llm.Message
	MaxRounds int   // default 20
}

// Run executes the agentic loop, streaming events to onEvent. It returns
// the final assistant text (sum of assistant_delta) on success.
func Run(ctx context.Context, llmClient *llm.Client, cfg RunConfig, onEvent func(Event)) (string, error) {
	if llmClient == nil {
		return "", errors.New("llm client required")
	}
	maxRounds := cfg.MaxRounds
	if maxRounds <= 0 {
		// Effectively unbounded — only stop when the task is done or the
		// caller cancels the context. See RunWithContext for rationale.
		maxRounds = 100000
	}
	system := cfg.System
	if system == "" {
		system = SystemPrompt
	}

	mgr := tools.NewManager(cfg.Cwd)

	// Build the message history the loop mutates. A system message comes
	// first; user/assistant turns are taken from cfg.Messages and extended.
	msgs := make([]llm.Message, 0, len(cfg.Messages)+4)
	msgs = append(msgs, llm.Message{Role: "system", Content: system})
	msgs = append(msgs, cfg.Messages...)

	var finalText strings.Builder

	for round := 1; round <= maxRounds; round++ {
		// Announce we're thinking at the start of each round.
		safeEmit(onEvent, Event{Tag: EventThinking, Round: round})

		// Stream this round. Collect the full assistant text.
		var acc strings.Builder
		req := llm.ChatRequest{
			Provider: cfg.Provider,
			Model:    cfg.Model,
			Stream:   true,
			Messages: msgs,
		}

		streamErr := streamWithRetry(ctx, llmClient, req, round, func(d llm.Delta) {
			if d.Delta != "" {
				acc.WriteString(d.Delta)
				safeEmit(onEvent, Event{Tag: EventAssistantDelta, Round: round, Delta: d.Delta})
			}
		}, onEvent)
		if streamErr != nil {
			// streamWithRetry already exhausted its retries (or hit a
			// non-transient error) and emitted an EventError. Bail out.
			return finalText.String(), streamErr
		}

		assistantText := acc.String()
		finalText.WriteString(assistantText)

		// Record the assistant turn.
		msgs = append(msgs, llm.Message{Role: "assistant", Content: assistantText})

		// Parse any tool_call blocks from this round.
		calls := parseToolCalls(assistantText)
		if len(calls) == 0 {
			if round < maxRounds && hasNonToolFencedCode(assistantText) {
				msgs = append(msgs, llm.Message{
					Role: "user",
					Content: "You pasted code in the chat without running it. Code in the chat does NOT execute — only a ```tool_call block does. To apply that code, use the `write` or `edit` tool:\n\n```tool_call\n{\"name\":\"write\",\"args\":{\"path\":\"<file>\",\"content\":\"<the code you just wrote>\"}}\n```\nIf the task is actually already complete and verified, reply with ONLY a short prose summary and no code blocks.",
				})
				continue
			}
			if round < maxRounds && isTrivialReply(assistantText) {
				msgs = append(msgs, llm.Message{
					Role: "user",
					Content: "That reply did not make any progress on the task. Either: (1) if there is real work to do, briefly state your plan in one sentence then emit ONE ```tool_call block to start (e.g. `ls {\"path\":\".\"}` or `read`), or (2) if the user's message is just a greeting / conversational with no coding task, reply with ONE short prose sentence that actually helps them (e.g. ask what they'd like to build or which file to work on). Do not simply echo the user's words.",
				})
				continue
			}
			// No more tools — the assistant is finished answering.
			safeEmit(onEvent, Event{Tag: EventDone, Round: round})
			return finalText.String(), nil
		}

		// Execute each call, emit request + result, and append a combined
		// tool_result message the model will see next round.
		var resultBlock strings.Builder
		for i, c := range calls {
			c.ID = fmt.Sprintf("r%d-t%d", round, i+1)
			safeEmit(onEvent, Event{Tag: EventToolRequest, Round: round, Tool: &c, Text: assistantText})

			res := mgr.Call(c.Name, c.Args)
			tr := ToolResult{
				ID:     c.ID,
				Name:   c.Name,
				OK:     res.OK,
				Output: res.Output,
			}
			safeEmit(onEvent, Event{Tag: EventToolResult, Round: round, Result: &tr})

			resultBlock.WriteString(fmt.Sprintf("tool_result %s (%s) ok=%v:\n%s\n\n", c.ID, c.Name, res.OK, res.Output))
		}

		// Deliver results back to the model as a user turn so the next
		// assistant response can use them.
		msgs = append(msgs, llm.Message{
			Role:    "user",
			Content: "Here are the tool results. Continue the task — verify, then either call more tools or give a final prose summary.\n\n" + resultBlock.String(),
		})
	}

	// Hit the round cap.
	safeEmit(onEvent, Event{
		Tag:   EventDone,
		Round: maxRounds,
		Error: "max rounds reached",
	})
	return finalText.String(), nil
}

// safeEmit never panics even if onEvent is nil.
func safeEmit(onEvent func(Event), ev Event) {
	if onEvent != nil {
		onEvent(ev)
	}
}

// streamWithRetry calls StreamChat; on a TRANSIENT upstream error (429 Too
// Many Requests, 5xx, etc.) it waits with exponential backoff and retries.
// The delay sequence is 1s, 2s, 4s, 8s, 16s, 32s (doubling each attempt).
// A non-transient error (missing key, auth 400/401/404, bad request) breaks
// out immediately. If "streaming not supported" we fall back to a
// non-streaming Chat call for this round.
//
// The retry sequence resets on every NEW user message (because each run()
// starts fresh), so a permanent chat stop is followed by a brand new 1s, 2s,
// 4s sequence on the next prompt — exactly the requested behavior.
//
// When a retry is scheduled we emit a `retry` event carrying the attempt
// number and the delay, so the UI can show "retrying in Ns…".
func streamWithRetry(
	ctx context.Context,
	client *llm.Client,
	req llm.ChatRequest,
	round int,
	onDelta func(llm.Delta),
	onEvent func(Event),
) error {
	// NEVER give up on transient upstream errors: retry indefinitely with
	// exponential backoff capped at 60s. The agent only stops when the task
	// is genuinely done OR the user cancels. This matches the requested
	// behavior: "never stop anything, retry every time".
	const (
		baseDelay   = 1 * time.Second
		maxDelay    = 60 * time.Second
	)

	for attempt := 0; ; attempt++ {
		err := client.StreamChat(ctx, req, onDelta)
		if err == nil {
			return nil // success
		}
		msg := strings.ToLower(err.Error())

		// "streaming not supported" is a permanent fallback signal, not a
		// transient error — switch to non-streaming Chat once. If that also
		// fails, treat the failure like any other upstream error: retry rather
		// than killing the whole task.
		if strings.Contains(msg, "streaming not supported") {
			resp, ferr := client.Chat(ctx, req)
			if ferr == nil {
				onDelta(llm.Delta{Delta: resp.Content})
				return nil
			}
			// Fall through to the retry path below, reusing the error from
			// the fallback Chat call so the UI shows what actually failed.
			err = ferr
			msg = strings.ToLower(err.Error())
		}

		// Non-transient errors (auth, bad model, missing key, 400/404) used to
		// abort the run. Now we surface them as a retry event too — the caller
		// (run loop) treats them as recoverable by asking the model to retry,
		// rather than killing the whole task. We still return the error here so
		// the run loop can decide how to handle it (it will nudge-and-continue).
		if !isTransientError(msg) {
			safeEmit(onEvent, Event{Tag: EventRetry, Round: round, Attempt: attempt + 1, DelayMs: int(baseDelay / time.Millisecond), Error: err.Error()})
			// Wait briefly (still cancellable), then keep retrying on the SAME
			// round. Many "non-transient" errors are actually transient in
			// practice (e.g. a 400 from a momentary provider hiccup), and
			// retrying is always safer than killing a long-running task.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff(attempt, baseDelay, maxDelay)):
			}
			continue
		}

		// Transient: retry with exponential backoff, capped, indefinitely.
		delay := backoff(attempt, baseDelay, maxDelay)
		safeEmit(onEvent, Event{
			Tag:     EventRetry,
			Round:   round,
			Attempt: attempt + 1,
			DelayMs: int(delay / time.Millisecond),
			Error:   err.Error(),
		})

		// Wait, but bail early if the context is cancelled (user pressed Stop).
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

// backoff returns baseDelay * 2^attempt, capped at maxDelay.
func backoff(attempt int, baseDelay, maxDelay time.Duration) time.Duration {
	if attempt <= 0 {
		return baseDelay
	}
	d := baseDelay << uint(attempt)
	if d <= 0 || d > maxDelay {
		return maxDelay
	}
	return d
}

// isTransientError reports whether an LLM upstream error is worth retrying.
// We retry on rate limits (429), server errors (5xx) and generic I/O noise
// (EOF, connection reset, deadline). We DO NOT retry auth/validation
// errors (400, 401, 403, 404) since they won't fix themselves.
func isTransientError(msg string) bool {
	// Allowlist of transient signal substrings (lowercased).
	transient := []string{
		"429", "too many requests", "rate limit", "rate-limit",
		"500", "502", "503", "504",
		"internal server error", "bad gateway", "service unavailable", "gateway timeout",
		"upstream", "timeout", "deadline", "eof", "connection reset",
		"broken pipe", "temporary", "try again", "retry",
	}
	for _, s := range transient {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// toolCallBlock matches a ```tool_call fenced block and captures the JSON.
var toolCallBlock = regexp.MustCompile("(?s)```tool_call\\s*\\n(.*?)\\n```")

// Generic fenced block: ```lang\n<body>\n``` (lang = json, tool, etc.). Used
// as a lenient fallback for weaker models that write ```json instead of
// ```tool_call, or omit the language tag entirely.
var genericFenced = regexp.MustCompile("(?s)```[a-zA-Z0-9_+-]*\\s*\\n(.*?)\\n```")

// A bare JSON object (no fence) whose top-level keys look like a tool call:
// {"name":"...","args":{...}} or {"tool":"...","args":{...}}. This rescues
// models that just print the JSON with no code fence. Unlike a regex, this
// uses a brace/quote-aware scan so it matches inline (mid-line) tool blobs
// and arbitrary nested/multi-line args — the case where a regex with anchors
// (^...$) and a fixed body pattern silently fails (e.g. the model writes the
// call mid-sentence, or args span many lines like a long file content).
var bareToolNameRe = regexp.MustCompile(`"\s*(name|tool|function)"\s*:\s*"[^"]+"`)

// findBareToolJSON scans text for a tool-call shaped JSON object starting at
// the given index. It handles string literals (ignoring braces inside them)
// and returns the full { ... } substring, or "" if none at i.
func findBareToolJSON(text string, i int) string {
	n := len(text)
	// Caller guarantees text[i] == '{' (the body of a JSON object start).
	if i >= n || text[i] != '{' {
		return ""
	}
	depth := 0
	inStr := false
	esc := false
	start := i
	for i < n {
		c := text[i]
		if inStr {
			if esc {
				esc = false
			} else if c == '\\' {
				esc = true
			} else if c == '"' {
				inStr = false
			}
		} else {
			switch c {
			case '"':
				inStr = true
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if (c == '}') && depth == 0 {
					return text[start : i+1]
				}
				if depth < 0 {
					return "" // unbalanced
				}
			}
		}
		i++
	}
	return ""
}

// extractToolFromJSON tries to parse a JSON blob into a ToolCall. It accepts
// the canonical {"name","args"} shape, the {"tool","args"} shape, and falls
// back to {"name","arguments"} / {"tool","arguments"} / {"name","parameters"}.
//
// It is LENIENT about one extremely common model mistake: printing the
// "content" arg with RAW (unescaped) control characters inside the JSON
// string literal — e.g. real newlines instead of "\n". Strict
// encoding/json rejects those ("invalid character '\n' in string literal"),
// which left such calls un-parsed, so the file was never written and the
// raw JSON streamed into the chat. We repair the obvious offenders (raw
// newlines / tabs inside strings) by re-escaping them, then retry.
func extractToolFromJSON(raw string) (ToolCall, bool) {
	parsed, ok := tryParseToolObj(raw)
	if ok {
		return parsed, true
	}
	// Lenient repair: re-escape raw newlines / tabs / carriage returns that
	// appear OUTSIDE any JSON string boundary we can detect is broken. The
	// safe approach is to walk the blob and, while inside a string literal,
	// replace a raw \n/\r/\t with its escaped form. This handles the common
	// case (and only that case) without a full JSON validator.
	repaired := escapeRawControlInStrings(raw)
	if repaired != raw {
		if p, ok2 := tryParseToolObj(repaired); ok2 {
			return p, true
		}
	}
	return ToolCall{}, false
}

// tryParseToolObj is the strict path: unmarshal and pull name/args.
func tryParseToolObj(raw string) (ToolCall, bool) {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return ToolCall{}, false
	}
	name, _ := parsed["name"].(string)
	if name == "" {
		name, _ = parsed["tool"].(string)
	}
	if name == "" {
		name, _ = parsed["function"].(string)
	}
	if name == "" {
		return ToolCall{}, false
	}
	// args may live under "args", "arguments", "parameters", or "input".
	argsRaw, ok := parsed["args"]
	if !ok {
		argsRaw, ok = parsed["arguments"]
	}
	if !ok {
		argsRaw, ok = parsed["parameters"]
	}
	if !ok {
		argsRaw, ok = parsed["input"]
	}
	if !ok {
		argsRaw = map[string]any{}
	}
	args, _ := json.Marshal(argsRaw)
	return ToolCall{Name: name, Args: args}, true
}

// escapeRawControlInStrings walks a JSON-shaped blob and re-escapes raw
// newline (\n), carriage return (\r) and tab (\t) bytes that occur INSIDE a
// string literal (i.e. between unescaped double quotes). Bytes outside
// strings are left untouched. This lets encoding/json parse blobs where the
// model printed multi-line file content with real newlines instead of the
// required \n escape.
func escapeRawControlInStrings(raw string) string {
	var out strings.Builder
	out.Grow(len(raw) + 8)
	inStr := false
	esc := false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if inStr {
			if esc {
				out.WriteByte(c)
				esc = false
				continue
			}
			switch c {
			case '\\':
				out.WriteByte(c)
				esc = true
			case '"':
				out.WriteByte(c)
				inStr = false
			case '\n':
				out.WriteString(`\n`)
			case '\r':
				out.WriteString(`\r`)
			case '\t':
				out.WriteString(`\t`)
			default:
				out.WriteByte(c)
			}
			continue
		}
		if c == '"' {
			inStr = true
		}
		out.WriteByte(c)
	}
	return out.String()
}

// parseToolCalls extracts tool calls from assistant text using several
// strategies, in order of preference, so weak models that don't follow the
// canonical ```tool_call format still get parsed:
//  1. canonical ```tool_call fenced blocks
//  2. any fenced block (```json / ```tool / ```) whose body parses as a tool
//  3. a bare JSON object on its own line with name+args keys
func parseToolCalls(text string) []ToolCall {
	var calls []ToolCall
	seen := map[string]bool{}

	add := func(c ToolCall) {
		key := c.Name + string(c.Args)
		if seen[key] {
			return
		}
		seen[key] = true
		c.ID = fmt.Sprintf("t%d", len(calls)+1)
		calls = append(calls, c)
	}

	// 1) Canonical ```tool_call blocks.
	for _, m := range toolCallBlock.FindAllStringSubmatch(text, -1) {
		if c, ok := extractToolFromJSON(strings.TrimSpace(m[1])); ok {
			add(c)
		}
	}
	if len(calls) > 0 {
		return calls
	}

	// 2) Generic fenced blocks (```json, ```tool, bare ```). Skip blocks that
	//    look like ordinary code (no name/tool key) when paused here.
	for _, m := range genericFenced.FindAllStringSubmatch(text, -1) {
		body := strings.TrimSpace(m[1])
		if c, ok := extractToolFromJSON(body); ok {
			add(c)
		}
	}
	if len(calls) > 0 {
		return calls
	}

	// 3) Bare JSON tool object anywhere in the text (no fence at all). Use a
	//    brace-aware scan rather than an anchored regex so inline blobs and
	//    arbitrarily nested/multi-line args are rescued — a regex with ^...$
	//    anchors silently misses the common case where the model writes the
	//    call mid-sentence or spreads args across many lines.
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		blob := findBareToolJSON(text, i)
		if blob == "" {
			continue
		}
		// Heuristic: only treat as a tool call if it has a name/tool key.
		if !bareToolNameRe.MatchString(blob) {
			continue
		}
		if c, ok := extractToolFromJSON(blob); ok {
			add(c)
			// Skip past the matched blob to avoid re-scanning its interior.
			i += len(blob) - 1
		}
	}
	return calls
}

// hasToolCallBlock reports whether the text contains any fenced code block at
// all (so a malformed tool attempt is distinguished from "model finished").
func hasToolCallBlock(text string) bool {
	if toolCallBlock.FindStringSubmatchIndex(text) != nil {
		return true
	}
	if genericFenced.FindStringSubmatchIndex(text) != nil {
		return true
	}
	// Bare inline JSON tool object anywhere (brace-aware scan).
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		blob := findBareToolJSON(text, i)
		if blob != "" && bareToolNameRe.MatchString(blob) {
			if _, ok := extractToolFromJSON(blob); ok {
				return true
			}
		}
	}
	return false
}

// fencedCodeRe matches any fenced code block (```lang\n...\n```) that is NOT
// a tool_call. Used to detect models that dump finished code in the chat
// instead of running a tool, so the loop can nudge them.
var fencedCodeRe = regexp.MustCompile("(?s)```([a-zA-Z0-9_+-]*)\\s*\\n[\\s\\S]*?\\n```")

// hasNonToolFencedCode reports whether the text has a fenced code block whose
// language tag is something other than tool_call (e.g. js, go, python),
// which means the model pasted code instead of calling a tool.
func hasNonToolFencedCode(text string) bool {
	for _, m := range fencedCodeRe.FindAllStringSubmatch(text, -1) {
		lang := strings.ToLower(strings.TrimSpace(m[1]))
		if lang == "tool_call" || lang == "tool" {
			continue
		}
		// If the body parses as a tool call, it's a lenient tool block — not
		// stray code. hasToolCallBlock already covers that path.
		body := strings.TrimSpace(m[0])
		body = strings.TrimPrefix(body, "```"+m[1])
		body = strings.TrimSpace(strings.TrimSuffix(body, "```"))
		if _, ok := extractToolFromJSON(body); ok {
			continue
		}
		return true
	}
	return false
}

// isTrivialReply reports whether an assistant reply (with no tool calls and
// no code blocks) is so short/substantive-less that it almost certainly just
// mirrored the user's input (e.g. saying "hi" back to "hi") instead of doing
// the task. We treat a reply as trivial when, after stripping whitespace and
// common greeting/markdown noise, it is under ~12 characters and doesn't
// contain a question mark or a verb hint of an answer.
func isTrivialReply(text string) bool {
	// Strip code fences (already known to be non-tool or absent) and trim.
	s := strings.TrimSpace(stripToolCallMarkers(text))
	if s == "" {
		return true
	}
	// Drop surrounding markdown emphasis / list markers / quotes.
	for _, p := range []string{"*", "_", "`", "#", ">", "-", "+"} {
		s = strings.Trim(s, p)
	}
	s = strings.TrimSpace(s)
	// A real answer usually contains a question or more than a handful of
	// words. A bare greeting / single word is trivial.
	if len(s) >= 12 {
		return false
	}
	if strings.Contains(s, "?") {
		return false
	}
	// Count words: a single token like "hi", "hello", "ok", "yes" is trivial.
	if len(strings.Fields(s)) <= 1 {
		return true
	}
	return false
}

// stripToolCallMarkers removes any ```tool_call fences and leftover
// {tool_call} markers so the triviality check looks at the prose only.
func stripToolCallMarkers(text string) string {
	s := toolCallBlock.ReplaceAllString(text, "")
	s = genericFenced.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "{tool_call}", "")
	return s
}

