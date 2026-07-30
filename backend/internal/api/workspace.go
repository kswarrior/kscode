package api

import (
	"net/http"
	"time"
)

// WorkspaceHandler exposes the configured workspace root and a health probe.
type WorkspaceHandler struct {
	rootFn    func() string
	apiDirFn  func() string
	staticFn  func() string
	startedAt time.Time
}

// NewWorkspaceHandler creates a handler bound to lazy accessor funcs.
func NewWorkspaceHandler(rootFn, apiDirFn, staticFn func() string) *WorkspaceHandler {
	return &WorkspaceHandler{
		rootFn:    rootFn,
		apiDirFn:  apiDirFn,
		staticFn:  staticFn,
		startedAt: time.Now(),
	}
}

func (h *WorkspaceHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", h.handleHealth)
	mux.HandleFunc("/api/workspace", h.handleWorkspace)
}

func (h *WorkspaceHandler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
		"uptime": time.Since(h.startedAt).String(),
	})
}

func (h *WorkspaceHandler) handleWorkspace(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"root":      h.rootFn(),
		"apiDir":    h.apiDirFn(),
		"staticDir": h.staticFn(),
	})
}
