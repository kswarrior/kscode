package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"kscode/internal/agent"
	"kscode/internal/llm"
)

// AgentHandler exposes the agentic SSE endpoint /api/agent/run.
type AgentHandler struct {
	client *llm.Client
	rootFn func() string
}

// NewAgentHandler builds the agent handler. rootFn returns the active
// project's root path (empty falls back to the workspace dir upstream);
// tools are sand-boxed to that root.
func NewAgentHandler(c *llm.Client, rootFn func() string) *AgentHandler {
	return &AgentHandler{client: c, rootFn: rootFn}
}

// Register wires the agent routes onto the mux.
func (h *AgentHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/agent/run", h.handleRun)
}

type agentRunRequest struct {
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	Messages []llm.Message  `json:"messages"`
	MaxRounds int           `json:"maxRounds,omitempty"`
	// Optional custom system prompt override (rarely used).
	System   string         `json:"system,omitempty"`
	Cwd      string         `json:"cwd,omitempty"`
}

// handleRun runs the agentic loop and streams events as SSE.
//
// Each event is emitted as:
//   data: {"tag":"thinking","round":1}\n\n
//   data: {"tag":"assistant_delta","delta":"..." }\n\n
//   data: {"tag":"tool_request","tool":{...}}\n\n
//   data: {"tag":"tool_result","result":{...}}\n\n
//   data: {"tag":"done"}\n\n
func (h *AgentHandler) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req agentRunRequest
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Provider == "" {
		writeError(w, http.StatusBadRequest, "provider required")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	send := func(ev agent.Event) {
		b, _ := json.Marshal(ev)
		fmt.Fprintf(w, "data: %s\n\n", string(b))
		flusher.Flush()
	}

	cwd := req.Cwd
	if cwd == "" {
		cwd = h.rootFn()
	}
	cfg := agent.RunConfig{
		Provider:  req.Provider,
		Model:     req.Model,
		Messages:  req.Messages,
		System:    req.System,
		Cwd:       cwd,
		MaxRounds: req.MaxRounds,
	}
	_, _ = agent.Run(ctx, h.client, cfg, send)
	// The loop emits its own done/error event; nothing else to do here.
}
