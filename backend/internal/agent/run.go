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
	EventDone           EventTag = "done"            // run finished cleanly
	EventError          EventTag = "error"           // failure
)

// Event is one streamed event. Default fields are used; only one of
// Delta/ToolCall/Result/Error is set depending on Tag.
type Event struct {
	Tag   EventTag       `json:"tag"`
	Round int            `json:"round,omitempty"`
	Delta string         `json:"delta,omitempty"`
	Text  string         `json:"text,omitempty"` // full assistant text for the round (sent with tool_request/* for context)
	Tool  *ToolCall      `json:"tool,omitempty"`
	Result *ToolResult   `json:"result,omitempty"`
	Error string         `json:"error,omitempty"`
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
		maxRounds = 20
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

		streamErr := llmClient.StreamChat(ctx, req, func(d llm.Delta) {
			if d.Delta != "" {
				acc.WriteString(d.Delta)
				safeEmit(onEvent, Event{Tag: EventAssistantDelta, Round: round, Delta: d.Delta})
			}
		})
		if streamErr != nil {
			// If the model errored mid-stream, surface it. If it's the
			// "streaming not supported" case, fall back to a non-stream
			// call for this round so providers that don't support SSE
			// still work in agent mode.
			if strings.Contains(strings.ToLower(streamErr.Error()), "streaming not supported") {
				resp, err := llmClient.Chat(ctx, req)
				if err != nil {
					safeEmit(onEvent, Event{Tag: EventError, Error: err.Error(), Round: round})
					return finalText.String(), err
				}
				acc.WriteString(resp.Content)
				safeEmit(onEvent, Event{Tag: EventAssistantDelta, Round: round, Delta: resp.Content})
			} else {
				safeEmit(onEvent, Event{Tag: EventError, Error: streamErr.Error(), Round: round})
				return finalText.String(), streamErr
			}
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
