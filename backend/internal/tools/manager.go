// Package tools implements the agent's executable tools: shell, file
// read/write/mkdir/delete/rename, glob and grep. Every tool is sand-boxed
// to the active project root (paths are resolved/rejected exactly like the
// public file API) and shell commands run with the project root as cwd.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Result is the structured output returned by every tool. OK is true on
// success. Output is a compact human/JSON-readable representation the LLM
// sees in the next message round.
type Result struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

func ok(out string) Result   { return Result{OK: true, Output: out} }
func fail(out string) Result { return Result{OK: false, Output: out} }

// Manager wires the tools to a sand-boxed root directory.
type Manager struct {
	root string
}

// NewManager builds a Manager rooted at the given project path.
func NewManager(root string) *Manager {
	abs, _ := filepath.Abs(root)
	return &Manager{root: abs}
}

// Root returns the absolute sandbox root.
func (m *Manager) Root() string { return m.root }

// resolve sandboxes a path under root, rejecting any escape with "..".
func (m *Manager) resolve(p string) (string, error) {
	if p == "" || p == "/" || p == "." {
		return m.root, nil
	}
	cleaned := filepath.Clean("/" + strings.TrimLeft(p, "/"))
	full := filepath.Join(m.root, cleaned)
	rel, err := filepath.Rel(m.root, full)
	if err != nil {
		return "", errors.New("invalid path")
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes project root")
	}
	return full, nil
}

func (m *Manager) rel(full string) string {
	rel, err := filepath.Rel(m.root, full)
	if err != nil {
		return full
	}
	if rel == "." {
		return "/"
	}
	return "/" + filepath.ToSlash(rel)
}

// Call dispatches a tool call by name with raw JSON args.
func (m *Manager) Call(name string, args json.RawMessage) Result {
	switch name {
	case "shell":
		var a ShellArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolShell(a)
	case "read":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolRead(a)
	case "write":
		var a WriteArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolWrite(a)
	case "mkdir":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolMkdir(a)
	case "delete":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolDelete(a)
	case "rename":
		var a RenameArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolRename(a)
	case "glob":
		var a GlobArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolGlob(a)
	case "grep":
		var a GrepArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolGrep(a)
	case "ls":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolLs(a)
	default:
		return fail("unknown tool: " + name)
	}
}

/* ------------------------------------------------------------------ *
 * Public arg structs so the agent package can also construct calls.
 * ------------------------------------------------------------------ */

type ShellArgs struct {
	Command string `json:"command"`
}
type PathArgs struct {
	Path string `json:"path"`
}
type WriteArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type RenameArgs struct {
	From string `json:"from"`
	To   string `json:"to"`
}
type GlobArgs struct {
	Pattern string `json:"pattern"`
}
type GrepArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
	Max     int    `json:"max"`
}

/* ------------------------------------------------------------------ *
 * shell
 * ------------------------------------------------------------------ */

func (m *Manager) toolShell(args ShellArgs) Result {
	cmd := strings.TrimSpace(args.Command)
	if cmd == "" {
		return fail("command is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, "sh", "-c", cmd)
	c.Dir = m.root
	var out, errOut bytes.Buffer
	c.Stdout = &out
	c.Stderr = &errOut
	err := c.Run()
	exitCode := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			return fail(fmt.Sprintf("run error: %v\n%s", err, strings.TrimSpace(errOut.String())))
		}
	}
	outTrim := strings.TrimSpace(out.String())
	errTrim := strings.TrimSpace(errOut.String())
	var sb strings.Builder
	if outTrim != "" {
		sb.WriteString(outTrim)
	}
	if errTrim != "" {
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("[stderr]\n" + errTrim)
	}
	result := sb.String()
	if result == "" {
		result = "(no output)"
	}
	if exitCode != 0 {
		result = fmt.Sprintf("[exit %d]\n%s", exitCode, result)
	}
	return ok(result)
}

/* ------------------------------------------------------------------ *
 * read
 * ------------------------------------------------------------------ */

func (m *Manager) toolRead(args PathArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	info, err := os.Stat(full)
	if err != nil {
		return fail("read error: " + cleanErr(err))
	}
	if info.IsDir() {
		return fail("path is a directory; use ls instead")
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return fail("read error: " + cleanErr(err))
	}
	return ok(string(b))
}

/* ------------------------------------------------------------------ *
 * write
 * ------------------------------------------------------------------ */

func (m *Manager) toolWrite(args WriteArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fail("mkdir parent: " + cleanErr(err))
	}
	if err := os.WriteFile(full, []byte(args.Content), 0o644); err != nil {
		return fail("write error: " + cleanErr(err))
	}
	return ok(fmt.Sprintf("wrote %d bytes to %s", len(args.Content), m.rel(full)))
}

/* ------------------------------------------------------------------ *
 * mkdir
 * ------------------------------------------------------------------ */

func (m *Manager) toolMkdir(args PathArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	if err := os.MkdirAll(full, 0o755); err != nil {
		return fail("mkdir error: " + cleanErr(err))
	}
	return ok("created directory " + m.rel(full))
}

/* ------------------------------------------------------------------ *
 * delete
 * ------------------------------------------------------------------ */

func (m *Manager) toolDelete(args PathArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	if full == m.root {
		return fail("cannot delete project root")
	}
	if err := os.RemoveAll(full); err != nil {
		return fail("delete error: " + cleanErr(err))
	}
	return ok("deleted " + m.rel(full))
}

/* ------------------------------------------------------------------ *
 * rename
 * ------------------------------------------------------------------ */

func (m *Manager) toolRename(args RenameArgs) Result {
	oldFull, err := m.resolve(args.From)
	if err != nil {
		return fail(err.Error())
	}
	newFull, err := m.resolve(args.To)
	if err != nil {
		return fail(err.Error())
	}
	if oldFull == m.root {
		return fail("cannot rename project root")
	}
	if err := os.MkdirAll(filepath.Dir(newFull), 0o755); err != nil {
		return fail("mkdir parent: " + cleanErr(err))
	}
	if err := os.Rename(oldFull, newFull); err != nil {
		return fail("rename error: " + cleanErr(err))
	}
	return ok(fmt.Sprintf("renamed %s -> %s", m.rel(oldFull), m.rel(newFull)))
}

/* ------------------------------------------------------------------ *
 * glob
 * ------------------------------------------------------------------ */

func (m *Manager) toolGlob(args GlobArgs) Result {
	pattern := strings.TrimSpace(args.Pattern)
	if pattern == "" {
		pattern = "**/*"
	}
	relPattern := strings.TrimPrefix(pattern, "/")
	matches, err := doublestarGlob(m.root, relPattern)
	if err != nil {
		return fail("glob error: " + err.Error())
	}
	if len(matches) == 0 {
		return ok("no matches")
	}
	return ok(strings.Join(matches, "\n"))
}

func doublestarGlob(root, pattern string) ([]string, error) {
	results := make([]string, 0, 32)
	var walkErr error
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			walkErr = err
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if name == ".git" || name == "node_modules" || name == "dist" || name == "build" {
				return fs.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if matchDoubleStar(rel, pattern) {
			results = append(results, "/"+rel)
		}
		return nil
	})
	if err == nil {
		err = walkErr
	}
	sort.Strings(results)
	return results, err
}

func matchDoubleStar(name, pattern string) bool {
	if pattern == "**" || pattern == "**/*" {
		return true
	}
	expr := globToRegex(pattern)
	re, err := regexp.Compile(expr)
	if err != nil {
		return false
	}
	return re.MatchString("/" + name)
}

// globToRegex translates a glob pattern into a regex anchored to a leading
// slash. Supports ** (any path segments) and * (any chars within a segment).
func globToRegex(pattern string) string {
	var b strings.Builder
	b.WriteString("(?s)^")
	segs := strings.Split(pattern, "/")
	for _, s := range segs {
		if s == "**" {
			b.WriteString("(/.*)?")
			continue
		}
		b.WriteString("/")
		for _, r := range []byte(s) {
			switch r {
			case '*':
				b.WriteString("[^/]*")
			case '.':
				b.WriteString("\\.")
			default:
				b.WriteByte(r)
			}
		}
	}
	b.WriteByte('$')
	return b.String()
}

/* ------------------------------------------------------------------ *
 * grep
 * ------------------------------------------------------------------ */

type grepHit struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Preview string `json:"preview"`
}

func (m *Manager) toolGrep(args GrepArgs) Result {
	needle := strings.TrimSpace(args.Pattern)
	if needle == "" {
		return fail("pattern is required")
	}
	max := args.Max
	if max <= 0 || max > 500 {
		max = 200
	}
	searchRoot, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	info, err := os.Stat(searchRoot)
	if err != nil {
		return fail("grep error: " + cleanErr(err))
	}
	if !info.IsDir() {
		searchRoot = filepath.Dir(searchRoot)
	}
	var re *regexp.Regexp
	if r, rerr := regexp.Compile(needle); rerr == nil {
		re = r
	} else {
		re = regexp.MustCompile(regexp.QuoteMeta(needle))
	}
	hits := make([]grepHit, 0, 32)
	skipDirs := map[string]bool{".git": true, "node_modules": true, "dist": true, "build": true}
	_ = filepath.WalkDir(searchRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if len(hits) >= max {
			return fs.SkipAll
		}
		inf, _ := d.Info()
		if inf != nil && inf.Size() > 2*1024*1024 {
			return nil
		}
		data, rerr := os.ReadFile(path)
		if rerr != nil {
			return nil
		}
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			if re.MatchString(line) {
				hits = append(hits, grepHit{
					Path:    m.rel(path),
					Line:    i + 1,
					Preview: strings.TrimSpace(line),
				})
				if len(hits) >= max {
					return fs.SkipAll
				}
			}
		}
		return nil
	})
	if len(hits) == 0 {
		return ok("no matches")
	}
	b, _ := json.Marshal(hits)
	return ok(string(b))
}

/* ------------------------------------------------------------------ *
 * ls
 * ------------------------------------------------------------------ */

func (m *Manager) toolLs(args PathArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	entries, err := os.ReadDir(full)
	if err != nil {
		return fail("ls error: " + cleanErr(err))
	}
	var sb strings.Builder
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		isDir := ""
		if e.IsDir() {
			isDir = "/"
		}
		sb.WriteString(name + isDir + "\n")
	}
	result := strings.TrimSpace(sb.String())
	if result == "" {
		result = "(empty)"
	}
	return ok(result)
}

func cleanErr(err error) string {
	return err.Error()
}
