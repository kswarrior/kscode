package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"kscode/internal/agent"
	"kscode/internal/llm"
)

// AgentHandler exposes the agentic SSE endpoint /api/agent/run.
type AgentHandler struct {
	client    *llm.Client
	rootFn    func() string
	taskMgr   *agent.TaskManager
}

// NewAgentHandler builds the agent handler. rootFn returns the active
// project's root path (empty falls back to the workspace dir upstream);
// tools are sand-boxed to that root.
func NewAgentHandler(c *llm.Client, rootFn func() string) *AgentHandler {
	return &AgentHandler{
		client:  c,
		rootFn:  rootFn,
		taskMgr: agent.NewTaskManager(),
	}
}

// Register wires the agent routes onto the mux.
func (h *AgentHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/agent/run", h.handleRun)
	mux.HandleFunc("/api/agent/stream", h.handleStream)
	mux.HandleFunc("/api/agent/stop", h.handleStop)
}

type agentRunRequest struct {
	Provider  string        `json:"provider"`
	Model     string        `json:"model"`
	Messages  []llm.Message `json:"messages"`
	MaxRounds int           `json:"maxRounds,omitempty"`
	System    string        `json:"system,omitempty"`
	Cwd       string        `json:"cwd,omitempty"`
}

// handleRun starts a background agent task and returns the task ID immediately.
// The client should then connect to /api/agent/stream?taskId=<id> to receive events.
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

	task := h.taskMgr.CreateTask(cfg)
	h.taskMgr.StartTask(task, h.client)

	writeJSON(w, http.StatusOK, map[string]string{
		"taskId": task.ID,
	})
}

// handleStream streams events for a task. If taskId is provided, it connects
// to an existing background task (replaying past events and then live events).
// If taskId is not provided, it runs a new inline task (legacy mode).
func (h *AgentHandler) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	taskId := r.URL.Query().Get("taskId")
	lastEventIdx, _ := strconv.Atoi(r.URL.Query().Get("lastEvent"))

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

	var task *agent.BackgroundTask
	var eventStartIdx int

	if taskId != "" {
		// Background task mode: replay past events then stream live
		var ok bool
		task, ok = h.taskMgr.GetTask(taskId)
		if !ok {
			send(agent.Event{Tag: agent.EventError, Error: "task not found: " + taskId})
			return
		}
		// Replay events from lastEventIdx
		allEvents := task.GetAllEvents()
		if lastEventIdx >= 0 && lastEventIdx < len(allEvents) {
			for _, e := range allEvents[lastEventIdx:] {
				send(e.Event)
			}
		}
		eventStartIdx = len(allEvents)

		// Stream new events as they arrive
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				allEvents := task.GetAllEvents()
				for eventStartIdx < len(allEvents) {
					send(allEvents[eventStartIdx].Event)
					eventStartIdx++
				}
				if task.GetStatus() == agent.TaskStatusCompleted ||
					task.GetStatus() == agent.TaskStatusStopped ||
					task.GetStatus() == agent.TaskStatusError {
					return
				}
			}
		}
	} else {
		// Legacy inline mode (no background task)
		cwd := r.URL.Query().Get("cwd")
		if cwd == "" {
			cwd = h.rootFn()
		}
		provider := r.URL.Query().Get("provider")
		model := r.URL.Query().Get("model")
		messagesJSON := r.URL.Query().Get("messages")
		if provider == "" {
			send(agent.Event{Tag: agent.EventError, Error: "provider required"})
			return
		}
		var messages []llm.Message
		if messagesJSON != "" {
			_ = json.Unmarshal([]byte(messagesJSON), &messages)
		}
		cfg := agent.RunConfig{
			Provider: provider,
			Model:    model,
			Messages: messages,
			Cwd:      cwd,
		}
		_, _ = agent.Run(ctx, h.client, cfg, send)
	}
}

// handleStop stops a background task.
func (h *AgentHandler) handleStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	taskId := r.URL.Query().Get("taskId")
	if taskId == "" {
		writeError(w, http.StatusBadRequest, "taskId required")
		return
	}
	if h.taskMgr.StopTask(taskId) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "stopped"})
	} else {
		writeError(w, http.StatusNotFound, "task not found: "+taskId)
	}
}