package main

import (
	"context"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"kscode/internal/api"
	"kscode/internal/config"
	fsSvc "kscode/internal/fs"
	"kscode/internal/llm"
	"kscode/internal/projects"
	"kscode/internal/settings"
	"kscode/internal/shell"
	"kscode/internal/web"
)

func main() {
	var port string
	flag.StringVar(&port, "port", "", "listen port (default: 6060)")
	flag.Parse()

	cfg := config.Default()

	// Configure runtime directories relative to the executable, so a single
	// self-contained binary can be dropped anywhere and just run.
	exePath, err := os.Executable()
	if err != nil {
		log.Fatalf("resolve executable: %v", err)
	}
	exeDir := filepath.Dir(exePath)
	if os.Getenv("KS_WORKSPACE") == "" {
		cfg.WorkspaceDir = filepath.Join(exeDir, "workspace")
	}
	if os.Getenv("KS_API_DIR") == "" {
		cfg.APIDir = filepath.Join(exeDir, "data")
	}

	// Resolve the listen port: explicit --port flag wins, then KS_PORT /
	// KS_ADDR env vars, otherwise default to :6060.
	addr := ""
	if port != "" {
		if _, err := strconv.Atoi(port); err != nil {
			log.Fatalf("invalid --port %q: must be a number", port)
		}
		addr = ":" + port
	} else if p := os.Getenv("KS_PORT"); p != "" {
		if _, err := strconv.Atoi(p); err != nil {
			log.Fatalf("invalid KS_PORT %q: must be a number", p)
		}
		addr = ":" + p
	} else if a := os.Getenv("KS_ADDR"); a != "" {
		addr = a
	} else {
		addr = ":6060"
	}
	cfg.Addr = addr

	// Use the embedded frontend assets bundled into the binary.
	if os.Getenv("KS_STATIC") == "" {
		cfg.StaticDir = "embedded"
	}

	if err := cfg.EnsureDirs(); err != nil {
		log.Fatalf("ensure dirs: %v", err)
	}
	configPath := filepath.Join(cfg.APIDir, "config.json")
	cfgStore, err := config.NewStore(configPath)
	if err != nil {
		log.Fatalf("config store: %v", err)
	}

	// Force the runtime-resolved settings (port flag, exe-relative dirs,
	// embedded frontend) to take precedence over any stale persisted
	// config.json so a freshly built single binary always "just runs".
	_ = cfgStore.Update(func(c *config.Config) {
		c.Addr = cfg.Addr
		c.WorkspaceDir = cfg.WorkspaceDir
		c.APIDir = cfg.APIDir
		c.StaticDir = cfg.StaticDir
	})

	settingsPath := filepath.Join(cfg.APIDir, "settings.json")
	settingsStore, err := settings.NewStore(settingsPath)
	if err != nil {
		log.Fatalf("settings store: %v", err)
	}

	projectsStore, err := projects.NewStore(cfg.APIDir)
	if err != nil {
		log.Fatalf("projects store: %v", err)
	}

	current := cfgStore.Get()

	// Root resolver: returns the active project's path when one is open,
	// otherwise the configured workspace dir.
	rootFn := func() string {
		if p, ok := projectsStore.Active(); ok && p.Path != "" {
			return p.Path
		}
		return cfgStore.Get().WorkspaceDir
	}

	fsSvc, err := fsSvc.NewService(rootFn())
	if err != nil {
		log.Fatalf("fs service: %v", err)
	}
	_ = fsSvc
	shellMgr := shell.NewManager()
	llmClient := llm.NewClient(settingsStore)

	filesHandler := api.NewFilesHandlerFromRoot(rootFn)
	shellHandler := api.NewShellHandler(shellMgr, rootFn)
	settingsHandler := api.NewSettingsHandler(settingsStore)
	llmHandler := api.NewLLMHandler(llmClient)
	workspaceHandler := api.NewWorkspaceHandler(
		rootFn,
		func() string { return cfgStore.Get().APIDir },
		func() string { return cfgStore.Get().StaticDir },
	)
	projectsHandler := api.NewProjectsHandler(projectsStore)

	server := api.New(filesHandler, shellHandler, settingsHandler, llmHandler, workspaceHandler, projectsHandler)

	allowed := map[string]bool{}
	for _, o := range current.AllowedOrigins {
		allowed[o] = true
	}
	allowed[current.FrontendOrigin] = true
	allowed["*"] = true // permissive for local development

	root := http.NewServeMux()
	root.Handle("/api/", server.Handler())
	spa := spaHandler(current.StaticDir, "/api/health")
	if current.StaticDir == "embedded" {
		spa = embeddedSpaHandler("/api/health")
	}
	root.Handle("/", spa)

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

// spaHandler serves the React app from an on-disk directory and falls back to
// index.html. Used when KS_STATIC points to a real folder (e.g. dev mode).
func spaHandler(staticDir, healthPath string) http.Handler {
	fsrv := http.FileServer(http.Dir(staticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == healthPath {
			http.NotFound(w, r)
			return
		}
		p := filepath.Join(staticDir, r.URL.Path)
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			fsrv.ServeHTTP(w, r)
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

// embeddedSpaHandler serves the React app that was embedded into the binary at
// build time (internal/web/dist) and falls back to index.html.
func embeddedSpaHandler(healthPath string) http.Handler {
	dist, err := fs.Sub(web.FS(), "dist")
	if err != nil {
		log.Fatalf("embed dist sub: %v", err)
	}
	fsrv := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == healthPath {
			http.NotFound(w, r)
			return
		}
		p := r.URL.Path
		serveAsset := false
		if p != "/" {
			if f, err := dist.Open(p[1:]); err == nil {
				info, _ := f.Stat()
				if info != nil && !info.IsDir() {
					serveAsset = true
				}
				_ = f.Close()
			}
		}
		if serveAsset {
			fsrv.ServeHTTP(w, r)
			return
		}
		// SPA fallback: serve index.html for any non-asset route.
		if f, err := dist.Open("index.html"); err == nil {
			b, _ := io.ReadAll(f)
			_ = f.Close()
			if b != nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write(b)
				return
			}
		}
		http.NotFound(w, r)
	})
}
