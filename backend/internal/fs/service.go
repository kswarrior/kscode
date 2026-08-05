package fs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var ErrNotFound = errors.New("not found")
var ErrInvalidPath = errors.New("invalid path")

type Entry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	ModTime  string `json:"modTime"`
	Children []Entry `json:"children,omitempty"`
}

type Service struct {
	root string
}

func NewService(root string) (*Service, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Service{root: abs}, nil
}

func (s *Service) Root() string { return s.root }

func (s *Service) Resolve(p string) (string, error) {
	return s.resolve(p)
}

func (s *Service) resolve(p string) (string, error) {
	if p == "" || p == "/" || p == "." {
		return s.root, nil
	}
	cleaned := filepath.Clean("/" + strings.TrimLeft(p, "/"))
	full := filepath.Join(s.root, cleaned)
	rel, err := filepath.Rel(s.root, full)
	if err != nil {
		return "", ErrInvalidPath
	}
	if strings.HasPrefix(rel, "..") || rel == ".." {
		return "", ErrInvalidPath
	}
	return full, nil
}

func (s *Service) Tree(p string, depth int) (*Entry, error) {
	full, err := s.resolve(p)
	if err != nil {
		return nil, err
	}
	return s.buildTree(full, depth, 0)
}

func (s *Service) buildTree(full string, depth, cur int) (*Entry, error) {
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	entry := &Entry{
		Name:    info.Name(),
		Path:    s.rel(full),
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime().Format(time.RFC3339),
	}
	if info.IsDir() && (depth < 0 || cur < depth) {
		names, err := readDirNames(full)
		if err != nil {
			return nil, err
		}
		for _, name := range names {
			child, err := s.buildTree(filepath.Join(full, name), depth, cur+1)
			if err != nil {
				continue
			}
			entry.Children = append(entry.Children, *child)
		}
	}
	return entry, nil
}

func readDirNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	filtered := names[:0]
	for _, n := range names {
		if strings.HasPrefix(n, ".") {
			continue
		}
		filtered = append(filtered, n)
	}
	return filtered, nil
}

func (s *Service) Rel(full string) string {
	return s.rel(full)
}

func (s *Service) rel(full string) string {
	rel, err := filepath.Rel(s.root, full)
	if err != nil {
		return full
	}
	if rel == "." {
		return "/"
	}
	return "/" + filepath.ToSlash(rel)
}

type FileContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Size     int64  `json:"size"`
	ModTime  string `json:"modTime"`
	Language string `json:"language"`
}

func (s *Service) Read(p string) (*FileContent, error) {
	full, err := s.resolve(p)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("cannot read a directory as file")
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return nil, err
	}
	return &FileContent{
		Path:     s.rel(full),
		Content:  string(b),
		Size:     info.Size(),
		ModTime:  info.ModTime().Format(time.RFC3339),
		Language: detectLanguage(full),
	}, nil
}

type WriteRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Service) Write(req WriteRequest) (*FileContent, error) {
	full, err := s.resolve(req.Path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(full, []byte(req.Content), 0o644); err != nil {
		return nil, err
	}
	info, err := os.Stat(full)
	if err != nil {
		return nil, err
	}
	return &FileContent{
		Path:     s.rel(full),
		Content:  req.Content,
		Size:     info.Size(),
		ModTime:  info.ModTime().Format(time.RFC3339),
		Language: detectLanguage(full),
	}, nil
}

func (s *Service) Mkdir(p string) (*Entry, error) {
	full, err := s.resolve(p)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(full, 0o755); err != nil {
		return nil, err
	}
	info, err := os.Stat(full)
	if err != nil {
		return nil, err
	}
	return &Entry{
		Name:    info.Name(),
		Path:    s.rel(full),
		IsDir:   true,
		Size:    0,
		ModTime: info.ModTime().Format(time.RFC3339),
	}, nil
}

func (s *Service) Delete(p string) error {
	full, err := s.resolve(p)
	if err != nil {
		return err
	}
	if full == s.root {
		return errors.New("cannot delete workspace root")
	}
	return os.RemoveAll(full)
}

func (s *Service) Rename(oldP, newP string) (*Entry, error) {
	oldFull, err := s.resolve(oldP)
	if err != nil {
		return nil, err
	}
	newFull, err := s.resolve(newP)
	if err != nil {
		return nil, err
	}
	if oldFull == s.root {
		return nil, errors.New("cannot rename workspace root")
	}
	if err := os.MkdirAll(filepath.Dir(newFull), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(oldFull, newFull); err != nil {
		return nil, err
	}
	info, err := os.Stat(newFull)
	if err != nil {
		return nil, err
	}
	entry := &Entry{
		Name:    info.Name(),
		Path:    s.rel(newFull),
		IsDir:   info.IsDir(),
		Size:    info.Size(),
		ModTime: info.ModTime().Format(time.RFC3339),
	}
	if info.IsDir() {
		child, err := s.buildTree(newFull, 1, 0)
		if err == nil {
			entry.Children = child.Children
		}
	}
	return entry, nil
}

type SearchResult struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Preview string `json:"preview"`
}

func (s *Service) Search(query string, max int) ([]SearchResult, error) {
	if query == "" {
		return nil, errors.New("empty query")
	}
	if max <= 0 {
		max = 200
	}
	results := make([]SearchResult, 0, 32)
	needle := []byte(query)
	skipDirs := map[string]bool{".git": true, "node_modules": true, "dist": true, "build": true}
	walkErr := filepath.WalkDir(s.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if int64(len(results)) >= int64(max) {
			return fs.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if info.Size() > 2*1024*1024 {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer f.Close()
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			if strings.Contains(line, query) {
				results = append(results, SearchResult{
					Path:    s.rel(path),
					Line:    i + 1,
					Preview: strings.TrimSpace(line),
				})
				if len(results) >= max {
					return fs.SkipAll
				}
			}
		}
		_ = needle
		return nil
	})
	if walkErr != nil {
		return results, walkErr
	}
	return results, nil
}

func detectLanguage(p string) string {
	ext := strings.ToLower(filepath.Ext(p))
	switch ext {
	case ".go":
		return "go"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx":
		return "javascript"
	case ".json":
		return "json"
	case ".md", ".markdown":
		return "markdown"
	case ".py":
		return "python"
	case ".rs":
		return "rust"
	case ".css":
		return "css"
	case ".html", ".htm":
		return "html"
	case ".yaml", ".yml":
		return "yaml"
	case ".sh", ".bash":
		return "shell"
	case ".sql":
		return "sql"
	case ".c":
		return "c"
	case ".cpp", ".cc", ".cxx":
		return "cpp"
	case ".java":
		return "java"
	default:
		return "plaintext"
	}
}
