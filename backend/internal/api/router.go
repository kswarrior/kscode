package api

import "net/http"

// Server bundles an http.ServeMux with all registered handlers.
type Server struct {
	mux *http.ServeMux
}

// New constructs the API mux with the given handlers.
func New(
	fsHandler *FilesHandler,
	shellHandler *ShellHandler,
	settingsHandler *SettingsHandler,
	llmHandler *LLMHandler,
	workspaceHandler *WorkspaceHandler,
	projectsHandler *ProjectsHandler,
	chatsHandler *ChatsHandler,
) *Server {
	mux := http.NewServeMux()
	fsHandler.Register(mux)
	shellHandler.Register(mux)
	settingsHandler.Register(mux)
	llmHandler.Register(mux)
	workspaceHandler.Register(mux)
	projectsHandler.Register(mux)
	chatsHandler.Register(mux)
	return &Server{mux: mux}
}

// Handler exposes the inner mux.
func (s *Server) Handler() http.Handler { return s.mux }
