package api

import (
	"net/http"
	"strings"

	"kscode/internal/chats"
)

type ChatsHandler struct {
	store *chats.Store
}

func NewChatsHandler(store *chats.Store) *ChatsHandler {
	return &ChatsHandler{store: store}
}

func (h *ChatsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/chats", h.handleCollection)
	mux.HandleFunc("/api/chats/one", h.handleOne)
	mux.HandleFunc("/api/chats/create", h.handleCreate)
	mux.HandleFunc("/api/chats/rename", h.handleRename)
	mux.HandleFunc("/api/chats/append", h.handleAppend)
	mux.HandleFunc("/api/chats/upsert", h.handleUpsert)
	mux.HandleFunc("/api/chats/meta", h.handleMeta)
	mux.HandleFunc("/api/chats/delete", h.handleDelete)
}

//   GET  /api/chats?projectId=         -> {chats: [...]}
//   POST /api/chats/create {projectId} -> Chat
func (h *ChatsHandler) handleCollection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	pid := r.URL.Query().Get("projectId")
	if pid == "" {
		writeError(w, http.StatusBadRequest, "projectId required")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": h.store.List(pid)})
}

func (h *ChatsHandler) handleOne(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	pid := r.URL.Query().Get("projectId")
	cid := r.URL.Query().Get("chatId")
	if pid == "" || cid == "" {
		writeError(w, http.StatusBadRequest, "projectId and chatId required")
		return
	}
	c, err := h.store.Get(pid, cid)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *ChatsHandler) handleCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct{ ProjectID string `json:"projectId"` }
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.ProjectID) == "" {
		writeError(w, http.StatusBadRequest, "projectId required")
		return
	}
	c, err := h.store.Create(req.ProjectID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *ChatsHandler) handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		ProjectID string `json:"projectId"`
		ChatID    string `json:"chatId"`
		Title     string `json:"title"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := h.store.Rename(req.ProjectID, req.ChatID, strings.TrimSpace(req.Title))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// handleAppend records one message into the chat history. The frontend streams
// via /api/llm/stream and then calls this to persist each finalized turn
// (user prompt and any completed assistant response).
func (h *ChatsHandler) handleAppend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		ProjectID string `json:"projectId"`
		ChatID    string `json:"chatId"`
		Role      string `json:"role"`
		Content   string `json:"content"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Role != "user" && req.Role != "assistant" && req.Role != "system" {
		writeError(w, http.StatusBadRequest, "invalid role")
		return
	}
	c, err := h.store.AppendMessage(req.ProjectID, req.ChatID, req.Role, req.Content)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// handleUpsert records or replaces the final assistant turn for a user
// prompt. Idempotent within a turn: it replaces the trailing assistant
// message if one exists, so repeated calls during a run never accumulate
// duplicate assistant messages. Carries tool-call cards so they render on
// reopen.
func (h *ChatsHandler) handleUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		ProjectID string                  `json:"projectId"`
		ChatID    string                  `json:"chatId"`
		Content   string                  `json:"content"`
		Tools     []chats.MessageTool     `json:"tools"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := h.store.UpsertAssistant(req.ProjectID, req.ChatID, req.Content, req.Tools)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *ChatsHandler) handleMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		ProjectID string `json:"projectId"`
		ChatID    string `json:"chatId"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := h.store.SetMeta(req.ProjectID, req.ChatID, req.Provider, req.Model)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *ChatsHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		methodNotAllowed(w, http.MethodPost, http.MethodDelete)
		return
	}
	var req struct {
		ProjectID string `json:"projectId"`
		ChatID    string `json:"chatId"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.store.Remove(req.ProjectID, req.ChatID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"chats": h.store.List(req.ProjectID),
	})
}
