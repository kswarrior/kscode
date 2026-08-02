package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type Provider struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	BaseURL  string   `json:"baseUrl,omitempty"`
	APIKey   string   `json:"apiKey,omitempty"`
	Enabled  bool     `json:"enabled"`
	Note     string   `json:"note,omitempty"`
	Models   []string `json:"models,omitempty"`
}

type AISettings struct {
	DefaultProvider string     `json:"defaultProvider"`
	Providers       []Provider `json:"providers"`
}

type UISettings struct {
	Theme       string `json:"theme"`
	FontSize    int    `json:"fontSize"`
	TabSize     int    `json:"tabSize"`
	WordWrap    bool   `json:"wordWrap"`
	Minimap     bool   `json:"minimap"`
}

type Settings struct {
	AI AISettings `json:"ai"`
	UI UISettings `json:"ui"`
}

func Default() Settings {
	return Settings{
		AI: AISettings{
			DefaultProvider: "gemini",
			Providers: []Provider{
				{ID: "gemini", Name: "Google Gemini", BaseURL: "https://generativelanguage.googleapis.com/v1beta", Enabled: false, Note: "Set GEMINI_API_KEY"},
				{ID: "nvidia", Name: "NVIDIA NIM", BaseURL: "https://integrate.api.nvidia.com/v1", Enabled: false, Note: "Set NVIDIA_API_KEY"},
				{ID: "openai", Name: "OpenAI", BaseURL: "https://api.openai.com/v1", Enabled: false, Note: "Set OPENAI_API_KEY"},
				{ID: "anthropic", Name: "Anthropic", BaseURL: "https://api.anthropic.com/v1", Enabled: false, Note: "Set ANTHROPIC_API_KEY"},
			},
		},
		UI: UISettings{
			Theme:    "vs-dark",
			FontSize: 14,
			TabSize:  2,
			WordWrap: true,
			Minimap:  true,
		},
	}
}

type Store struct {
	path string
	mu   sync.RWMutex
	s    Settings
}

func NewStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	st := &Store{path: path, s: Default()}
	if err := st.load(); err != nil {
		return nil, err
	}
	return st, nil
}

func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp := s.s
	cp.AI.Providers = make([]Provider, len(s.s.AI.Providers))
	copy(cp.AI.Providers, s.s.AI.Providers)
	return cp
}

func (s *Store) Save(in Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range in.AI.Providers {
		if p.ID == "" {
			return errors.New("provider id required")
		}
		in.AI.Providers[i].ID = strings.TrimSpace(p.ID)
		in.AI.Providers[i].APIKey = strings.TrimSpace(p.APIKey)
	}
	s.s = in
	return s.save()
}

func (s *Store) UpsertProvider(p Provider) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for i, existing := range s.s.AI.Providers {
		if existing.ID == p.ID {
			s.s.AI.Providers[i] = p
			found = true
			break
		}
	}
	if !found {
		s.s.AI.Providers = append(s.s.AI.Providers, p)
	}
	return s.save()
}

func (s *Store) DeleteProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.s.AI.Providers[:0]
	for _, p := range s.s.AI.Providers {
		if p.ID != id {
			out = append(out, p)
		}
	}
	s.s.AI.Providers = out
	return s.save()
}

// UpdateProviderModels adds or removes a model name on the provider with the
// given id. action must be "add" or "remove". Adding a duplicate name is a
// no-op; removing a missing name is a no-op.
func (s *Store) UpdateProviderModels(id, model, action string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	model = strings.TrimSpace(model)
	if model == "" {
		return errors.New("model name required")
	}
	if action != "add" && action != "remove" {
		return errors.New(`action must be "add" or "remove"`)
	}
	found := false
	for i := range s.s.AI.Providers {
		if s.s.AI.Providers[i].ID != id {
			continue
		}
		found = true
		models := s.s.AI.Providers[i].Models
		if action == "add" {
			for _, m := range models {
				if m == model {
					return nil
				}
			}
			models = append(models, model)
		} else {
			out := models[:0]
			for _, m := range models {
				if m != model {
					out = append(out, m)
				}
			}
			models = out
		}
		s.s.AI.Providers[i].Models = models
		break
	}
	if !found {
		return errors.New("provider not found: " + id)
	}
	return s.save()
}

func (s *Store) KeyFor(id string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.s.AI.Providers {
		if p.ID == id {
			return p.APIKey
		}
	}
	return ""
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s.save()
		}
		return err
	}
	return json.Unmarshal(b, &s.s)
}

func (s *Store) save() error {
	b, err := json.MarshalIndent(s.s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}
