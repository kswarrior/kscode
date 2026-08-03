package chats

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

// Message stores a single chat turn. Content is set on user turns; the
// streamed response is appended later by Update().
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Chat struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt string    `json:"createdAt"`
	UpdatedAt string    `json:"updatedAt"`
	Model     string    `json:"model,omitempty"`
	Provider  string    `json:"provider,omitempty"`
	Messages  []Message `json:"messages"`
}

// Persisted shape: map of projectID -> []Chat.
type dataShape struct {
	ByProject map[string][]Chat `json:"byProject"`
}

type Store struct {
	path string
	mu   sync.Mutex
	data dataShape
}

func NewStore(apiDir string) (*Store, error) {
	if err := os.MkdirAll(apiDir, 0o755); err != nil {
		return nil, err
	}
	st := &Store{path: filepath.Join(apiDir, "chats.json")}
	if err := st.load(); err != nil {
		return nil, err
	}
	return st, nil
}

func (s *Store) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			// Initialize an empty store instead of saving a zero-shaped file
			// (which would leave ByProject nil after a fresh save + read).
			s.data = dataShape{ByProject: map[string][]Chat{}}
			return s.save()
		}
		return err
	}
	var d dataShape
	if err := json.Unmarshal(b, &d); err != nil {
		return err
	}
	if d.ByProject == nil {
		d.ByProject = map[string][]Chat{}
	}
	s.data = d
	return nil
}

func (s *Store) save() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}

// List returns the chats for projectID sorted newest first.
func (s *Store) List(projectID string) []Chat {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Chat, len(s.data.ByProject[projectID]))
	copy(out, s.data.ByProject[projectID])
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

// Get returns one chat.
func (s *Store) Get(projectID, chatID string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.data.ByProject[projectID] {
		if c.ID == chatID {
			return c, nil
		}
	}
	return Chat{}, errors.New("chat not found")
}

// Create inserts a new chat for projectID with a generated title.
func (s *Store) Create(projectID string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.ByProject == nil {
		s.data.ByProject = map[string][]Chat{}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	c := Chat{
		ID:        newID(),
		Title:     "New chat",
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.data.ByProject[projectID] = append(s.data.ByProject[projectID], c)
	return c, s.save()
}

// Rename updates a chat title.
func (s *Store) Rename(projectID, chatID, title string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.data.ByProject[projectID] {
		if c.ID == chatID {
			c.Title = title
			c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			s.data.ByProject[projectID][i] = c
			return c, s.save()
		}
	}
	return Chat{}, errors.New("chat not found")
}

// SetMeta stores the last-used provider/model on the chat.
func (s *Store) SetMeta(projectID, chatID, provider, model string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.data.ByProject[projectID] {
		if c.ID == chatID {
			c.Provider = provider
			c.Model = model
			c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			s.data.ByProject[projectID][i] = c
			return c, s.save()
		}
	}
	return Chat{}, errors.New("chat not found")
}

// AppendMessage append a message to the chat. When role is "user" and the
// chat still has the default title, the title is auto-derived from the first
// message content.
func (s *Store) AppendMessage(projectID, chatID, role, content string) (Chat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.data.ByProject[projectID] {
		if c.ID == chatID {
			c.Messages = append(c.Messages, Message{Role: role, Content: content})
			if role == "user" && (c.Title == "" || c.Title == "New chat") {
				c.Title = deriveTitle(content)
			}
			c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			s.data.ByProject[projectID][i] = c
			return c, s.save()
		}
	}
	return Chat{}, errors.New("chat not found")
}

// Remove deletes a chat.
func (s *Store) Remove(projectID, chatID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.ByProject == nil {
		s.data.ByProject = map[string][]Chat{}
	}
	conv := s.data.ByProject[projectID]
	out := conv[:0]
	for _, c := range conv {
		if c.ID != chatID {
			out = append(out, c)
		}
	}
	s.data.ByProject[projectID] = out
	return s.save()
}

// RemoveProject drops every chat for projectID (call when a project is removed).
func (s *Store) RemoveProject(projectID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.ByProject == nil {
		s.data.ByProject = map[string][]Chat{}
	}
	delete(s.data.ByProject, projectID)
	_ = s.save()
}

func deriveTitle(content string) string {
	s := content
	if len(s) > 48 {
		s = s[:48] + "…"
	}
	for i, ch := range s {
		if ch == '\n' || ch == '\r' {
			s = s[:i]
			break
		}
	}
	if s == "" {
		s = "Chat"
	}
	return s
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
