package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"kscode/internal/llm"
)

type LLMHandler struct {
	client *llm.Client
}

func NewLLMHandler(c *llm.Client) *LLMHandler {
	return &LLMHandler{client: c}
}

func (h *LLMHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/llm/chat", h.handleChat)
	mux.HandleFunc("/api/llm/stream", h.handleStream)
}

func (h *LLMHandler) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req llm.ChatRequest
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	resp, err := h.client.Chat(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleStream forwards a chat request as a Server-Sent Events stream. Each
// chunk the upstream model produces is emitted as an SSE event of the form:
//   data: {"delta":"..."}
// The final event is `data: {"done":true}` (or `data: {"error":"..."}`).
// Browsers receive this via EventSource / fetch ReadableStream on the client.
func (h *LLMHandler) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req llm.ChatRequest
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.Stream = true

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

	send := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", string(b))
		flusher.Flush()
	}

	err := h.client.StreamChat(r.Context(), req, func(d llm.Delta) {
		if d.Error != "" {
			send(map[string]any{"error": d.Error})
			return
		}
		if d.Done {
			send(map[string]any{"done": true})
			return
		}
		send(map[string]any{"delta": d.Delta})
	})
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "api key") {
			send(map[string]any{"error": msg})
			return
		}
		send(map[string]any{"error": msg})
	}
}
