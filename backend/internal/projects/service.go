package projects

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	CreatedAt string `json:"createdAt"`
}

type Store struct {
	path       string
	mu         sync.Mutex
	projects   []Project
	activeID   string
}

func NewStore(apiDir string) (*Store, error) {
	if err := os.MkdirAll(apiDir, 0o755); err != nil {
		return nil, err
	}
	st := &Store{path: filepath.Join(apiDir, "projects.json")}
	if err := st.load(); err != nil {
		return nil, err
	}
	return st, nil
}

func (s *Store) List() []Project {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Project, len(s.projects))
	copy(out, s.projects)
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

func (s *Store) Get(id string) (Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}

// Add stores a project entry pointing at path. When create is true, the path
// is created (with parents) when it does not exist; otherwise the path must
// already be an existing directory.
// After Add, the project is a candidate for "active"; the active project is
// re-evaluated lazily by Active()/SetActive().
func (s *Store) Add(name, path string, create bool) (Project, error) {
	name = filepath.Clean(name)
	path = filepath.Clean(path)
	if name == "" || name == "." {
		return Project{}, errors.New("name required")
	}
	if path == "" || path == "." {
		return Project{}, errors.New("path required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return Project{}, err
	}
	info, statErr := os.Stat(abs)
	if statErr != nil {
		if !create {
			return Project{}, errors.New("project path not found: " + abs)
		}
		if err := os.MkdirAll(abs, 0o755); err != nil {
			return Project{}, err
		}
		info, statErr = os.Stat(abs)
		if statErr != nil {
			return Project{}, statErr
		}
	}
	if !info.IsDir() {
		return Project{}, errors.New("project path is not a directory: " + abs)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// de-dupe by absolute path
	for i := range s.projects {
		if filepath.Clean(s.projects[i].Path) == abs {
			// update name in place if it changed
			if s.projects[i].Name != name {
				s.projects[i].Name = name
				if err := s.save(); err != nil {
					return Project{}, err
				}
			}
			return s.projects[i], nil
		}
	}
	p := Project{
		ID:        newID(),
		Name:      name,
		Path:      abs,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	s.projects = append(s.projects, p)
	if s.activeID == "" {
		s.activeID = p.ID
	}
	return p, s.save()
}

// Rename updates the display name and/or path of an existing project.
// When newPath is provided and create is true, the new path is created if
// missing. The old on-disk directory is NOT moved.
func (s *Store) Rename(id, newName, newPath string, create bool) (Project, error) {
	if id == "" {
		return Project{}, errors.New("id required")
	}
	if newName == "" && newPath == "" {
		return Project{}, errors.New("nothing to rename")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.projects {
		if p.ID != id {
			continue
		}
		if newName != "" {
			p.Name = newName
		}
		if newPath != "" {
			abs, err := filepath.Abs(filepath.Clean(newPath))
			if err != nil {
				return Project{}, err
			}
			info, statErr := os.Stat(abs)
			if statErr != nil {
				if !create {
					return Project{}, errors.New("project path not found: " + abs)
				}
				if err := os.MkdirAll(abs, 0o755); err != nil {
					return Project{}, err
				}
			} else if !info.IsDir() {
				return Project{}, errors.New("project path is not a directory: " + abs)
			}
			p.Path = abs
		}
		s.projects[i] = p
		return p, s.save()
	}
	return Project{}, errors.New("project not found: " + id)
}

func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.projects[:0]
	for _, p := range s.projects {
		if p.ID != id {
			out = append(out, p)
		}
	}
	s.projects = out
	if s.activeID == id {
		s.activeID = ""
		if len(s.projects) > 0 {
			s.activeID = s.projects[0].ID
		}
	}
	return s.save()
}

func (s *Store) Active() (Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects {
		if p.ID == s.activeID {
			return p, true
		}
	}
	if len(s.projects) > 0 {
		s.activeID = s.projects[0].ID
		_ = s.save()
		return s.projects[0], true
	}
	return Project{}, false
}

func (s *Store) SetActive(id string) (Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects {
		if p.ID == id {
			s.activeID = id
			return p, s.save()
		}
	}
	return Project{}, errors.New("project not found: " + id)
}

type persistedShape struct {
	Projects []Project `json:"projects"`
	Active   string   `json:"activeId"`
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s.save()
		}
		return err
	}
	var ps persistedShape
	if err := json.Unmarshal(b, &ps); err != nil {
		return err
	}
	s.projects = ps.Projects
	s.activeID = ps.Active
	return nil
}

func (s *Store) save() error {
	b, err := json.MarshalIndent(persistedShape{Projects: s.projects, Active: s.activeID}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}

func newID() string {
	return time.Now().UTC().Format("20060102T150405Z") + "-" + randHex(4)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	const hex = "0123456789abcdef"
	out := make([]byte, n*2)
	for i, v := range b {
		out[i*2] = hex[v>>4]
		out[i*2+1] = hex[v&0x0f]
	}
	return string(out)
}
