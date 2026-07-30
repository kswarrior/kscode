package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Config struct {
	Addr           string            `json:"addr"`
	WorkspaceDir   string            `json:"workspaceDir"`
	StaticDir      string            `json:"staticDir"`
	APIDir         string            `json:"apiDir"`
	FrontendOrigin string            `json:"frontendOrigin"`
	AllowedOrigins []string          `json:"allowedOrigins"`
	Env            map[string]string `json:"env"`
}

func envDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func Default() *Config {
	cfg := &Config{
		Addr:           envDefault("KS_ADDR", ":8080"),
		WorkspaceDir:   envDefault("KS_WORKSPACE", "/test/ks-code/workspace"),
		StaticDir:      envDefault("KS_STATIC", "/test/ks-code/frontend/dist"),
		APIDir:         envDefault("KS_API_DIR", "/test/ks-code/backend/data"),
		FrontendOrigin: envDefault("KS_FRONTEND_ORIGIN", "http://localhost:5173"),
		AllowedOrigins: []string{"http://localhost:5173", "http://127.0.0.1:5173"},
		Env:            map[string]string{},
	}
	return cfg
}

func (c *Config) EnsureDirs() error {
	for _, p := range []string{c.WorkspaceDir, c.APIDir} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			return err
		}
	}
	return nil
}

type Store struct {
	path string
	mu   sync.RWMutex
	cfg  *Config
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path, cfg: Default()}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Get() *Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp := *s.cfg
	env := make(map[string]string, len(s.cfg.Env))
	for k, v := range s.cfg.Env {
		env[k] = v
	}
	cp.Env = env
	return &cp
}

func (s *Store) Update(fn func(*Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.cfg)
	return s.save()
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
				return err
			}
			return s.save()
		}
		return err
	}
	return json.Unmarshal(b, s.cfg)
}

func (s *Store) save() error {
	b, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}
