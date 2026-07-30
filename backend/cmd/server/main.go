package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"kscode/internal/api"
	"kscode/internal/config"
	"kscode/internal/fs"
	"kscode/internal/llm"
	"kscode/internal/settings"
	"kscode/internal/shell"
)

func main() {
	cfg := config.Default()
	if err := cfg.EnsureDirs(); err != nil {
		log.Fatalf("ensure dirs: %v", err)
	}
	configPath := filepath.Join(cfg.APIDir, "config.json")
	cfgStore, err := config.NewStore(configPath)
	if err != nil {
		log.Fatalf("config store: %v", err)
	}
	settingsPath := filepath.Join(cfg.APIDir, "settings.json")
	settingsStore, err := settings.NewStore(settingsPath)
	if err != nil {
		log.Fatalf("settings store: %v", err)
	}

	current := cfgStore.Get()

	fsSvc, err := fs.NewService(current.WorkspaceDir)
	if err != nil {
		log.Fatalf("fs service: %v", err)
	}
	shellMgr := shell.NewManager()
	llmClient := llm.NewClient(settingsStore)

	filesHandler := api.NewFilesHandler(fsSvc)
	shellHandler := api.NewShellHandler(shellMgr, func() string { return cfgStore.Get().WorkspaceDir })
	settingsHandler := api.NewSettingsHandler(settingsStore)
	llmHandler := api.NewLLMHandler(llmClient)
	workspaceHandler := api.NewWorkspaceHandler(
		func() string { return cfgStore.Get().WorkspaceDir },
		func() string { return cfgStore.Get().APIDir },
		func() string { return cfgStore.Get().StaticDir },
	)

	server := api.New(filesHandler, shellHandler, settingsHandler, llmHandler, workspaceHandler)

	allowed := map[string]bool{}
	for _, o := range current.AllowedOrigins {
		allowed[o] = true
	}
	allowed[current.FrontendOrigin] = true
	allowed["*"] = true // permissive for local development

	root := http.NewServeMux()
	root.Handle("/api/", server.Handler())
	root.Handle("/", spaHandler(current.StaticDir, "/api/health"))

	handler := api.CORSMiddleware(allowed, root)
	handler = api.Recoverer(handler)
	handler = api.Logger(handler)

	srv := &http.Server{
		Addr:              current.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("KS Code server listening on %s (workspace=%s)", current.Addr, current.WorkspaceDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// spaHandler serves the embedded React app and falls back to index.html.
func spaHandler(staticDir, healthPath string) http.Handler {
	fs := http.FileServer(http.Dir(staticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == healthPath {
			http.NotFound(w, r)
			return
		}
		p := filepath.Join(staticDir, r.URL.Path)
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		index := filepath.Join(staticDir, "index.html")
		if _, err := os.Stat(index); err == nil {
			http.ServeFile(w, r, index)
			return
		}
		http.NotFound(w, r)
	})
}
