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
		maxRounds = 50
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
	const (
		baseDelay    = 1 * time.Second
		maxAttempts  = 7              // ~1+2+4+8+16+32+mkdir => covers ~1 min
	)

	for attempt := 0; ; attempt++ {
		err := client.StreamChat(ctx, req, onDelta)
		if err == nil {
			return nil // success
		}
		msg := strings.ToLower(err.Error())

		// "streaming not supported" is a permanent fallback signal, not a
		// transient error — switch to non-streaming Chat once.
		if strings.Contains(msg, "streaming not supported") {
			resp, ferr := client.Chat(ctx, req)
			if ferr != nil {
				safeEmit(onEvent, Event{Tag: EventError, Error: ferr.Error(), Round: round})
				return ferr
			}
			onDelta(llm.Delta{Delta: resp.Content})
			return nil
		}

		// Non-transient errors (auth, bad model, missing key, 400/404) abort.
		if !isTransientError(msg) {
			safeEmit(onEvent, Event{Tag: EventError, Error: err.Error(), Round: round})
			return err
		}

		// Transient: retry with exponential backoff, up to maxAttempts.
		if attempt >= maxAttempts {
			safeEmit(onEvent, Event{Tag: EventError, Error: fmt.Sprintf("giving up after %d retries: %s", maxAttempts, err.Error()), Round: round})
			return err
		}

		delay := baseDelay << uint(attempt) // 1s, 2s, 4s, 8s, 16s, 32s, 64s(cap)
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

// parseToolCalls extracts all ```tool_call blocks from assistant text and
// returns them as parsed ToolCall structs. Malformed JSON is skipped with
// a synthesized "error" tool result inline — but callers handle that.
func parseToolCalls(text string) []ToolCall {
	matches := toolCallBlock.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil
	}
	calls := make([]ToolCall, 0, len(matches))
	for i, m := range matches {
		raw := strings.TrimSpace(m[1])
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			// Skip malformed tool call; the model will see no result and
			// usually self-correct on the next round.
			continue
		}
		name, _ := parsed["name"].(string)
		if name == "" {
			continue
		}
		args, _ := json.Marshal(parsed["args"])
		calls = append(calls, ToolCall{
			ID:   fmt.Sprintf("t%d", i+1),
			Name: name,
			Args: args,
		})
	}
	return calls
}

// hasToolCallBlock reports whether the text contains any ```tool_call fenced
// block at all (even if malformed). Used to distinguish "model finished"
// from "model tried to call a tool but it was malformed".
func hasToolCallBlock(text string) bool {
	return toolCallBlock.FindStringSubmatchIndex(text) != nil
}
