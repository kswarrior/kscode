package api

import (
	"net/http"

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
