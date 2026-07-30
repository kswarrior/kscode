package api

import (
	"net/http"

	"kscode/internal/settings"
)

type SettingsHandler struct {
	store *settings.Store
}

func NewSettingsHandler(store *settings.Store) *SettingsHandler {
	return &SettingsHandler{store: store}
}

func (h *SettingsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/settings", h.handleSettings)
	mux.HandleFunc("/api/settings/providers", h.handleProviders)
	mux.HandleFunc("/api/settings/providers/delete", h.handleDeleteProvider)
}

func (h *SettingsHandler) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, h.store.Get())
	case http.MethodPost:
		var s settings.Settings
		if err := parseJSON(r, &s); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := h.store.Save(s); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, h.store.Get())
	default:
		methodNotAllowed(w, http.MethodGet, http.MethodPost)
	}
}

func (h *SettingsHandler) handleProviders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var p settings.Provider
	if err := parseJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.store.UpsertProvider(p); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, h.store.Get())
}

func (h *SettingsHandler) handleDeleteProvider(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.store.DeleteProvider(req.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, h.store.Get())
}
