package api

import (
	"net/http"
	"strings"

	"kscode/internal/projects"
)

type ProjectsHandler struct {
	store *projects.Store
}

func NewProjectsHandler(store *projects.Store) *ProjectsHandler {
	return &ProjectsHandler{store: store}
}

func (h *ProjectsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/projects", h.handleCollection)
	mux.HandleFunc("/api/projects/active", h.handleActive)
	mux.HandleFunc("/api/projects/delete", h.Delete)
}

// handleCollection handles GET (list) and POST (add by name+path).
func (h *ProjectsHandler) handleCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"projects": h.store.List(),
		})
	case http.MethodPost:
		var req struct {
			Name string `json:"name"`
			Path string `json:"path"`
		}
		if err := parseJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		p, err := h.store.Add(strings.TrimSpace(req.Name), strings.TrimSpace(req.Path))
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, p)
	default:
		methodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func (h *ProjectsHandler) handleActive(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		p, ok := h.store.Active()
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"project": nil})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"project": p})
	}
	if r.Method == http.MethodPost {
		var req struct {
			ID string `json:"id"`
		}
		if err := parseJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		p, err := h.store.SetActive(req.ID)
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, p)
	}
}

// DeleteProject is exposed on the same path with method DELETE-like POST.
func (h *ProjectsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		methodNotAllowed(w, http.MethodPost, http.MethodDelete)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.store.Remove(req.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"projects": h.store.List(),
	})
}
