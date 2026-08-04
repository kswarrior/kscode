// Package tools implements the agent's executable tools, modelled on the
// toolsets used by opencode / Claude Code. Tools are sand-boxed to the
// active project root: every path is resolved against the root and any
// escape with ".." or an absolute path outside the root is rejected.
//
// Available tools:
//
//	shell      run a shell command in the project root (cwd=root)
//	read       read a whole file (use shell + sed for ranges)
//	write      create or overwrite a file with full content
//	edit       precise in-place edit of a file (replace an exact string
//	           with a new one; optional replaceAll)
//	multi_edit batch several edits to the same file in one call
//	patch      apply a unified diff to the tree
//	mkdir      create a directory (and parents)
//	delete     remove a file or directory
//	rename     move/rename a file or directory
//	glob       find files by glob pattern (** aware)
//	grep       search file contents with a regex
//	ls         list directory entries
//	list_files recursive-ish listing with sizes/types
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
// success. Output is a compact, human/JSON-readable representation the
// model sees in the next message round and the UI renders in a card.
type Result struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

func ok(out string) Result    { return Result{OK: true, Output: out} }
func fail(out string) Result  { return Result{OK: false, Output: out} }
func failf(format string, args ...any) Result { return Result{OK: false, Output: fmt.Sprintf(format, args...)} }

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

// resolve sandboxes a path under root, rejecting any escape.
//
// Importantly, paths are interpreted RELATIVE TO ROOT no matter their
// surface form:
//
//	"src/app.js"        -> <root>/src/app.js
//	"/src/app.js"       -> <root>/src/app.js   (leading slash stripped)
//	"<root>/src/app.js" -> <root>/src/app.js   (absolute path inside root)
//
// Absolute paths that point outside the sandbox root are rejected with
// "path escapes project root". This is what makes the tools robust to a
// model echoing the project's absolute path (the failure mode that used to
// produce "<root>/<root>/...: no such file or directory").
func (m *Manager) resolve(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || p == "/" || p == "." {
		return m.root, nil
	}

	// If the caller hands us an absolute path that already starts with the
	// project root, treat it as that same path (strip the root prefix so we
	// re-resolve consistently). This is the common case where the model
	// learns the absolute location from a `shell pwd` and repeats it.
	abs := p
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(m.root, abs)
	}
	abs = filepath.Clean(abs)

	// If it's an absolute path under root, keep it. If it's absolute and
	// NOT under root, reject (escape). If relative, anchor under root.
	if filepath.IsAbs(p) {
		rel, err := filepath.Rel(m.root, abs)
		if err != nil {
			return "", errors.New("invalid path")
		}
		if rel == "." {
			return m.root, nil
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", errors.New("path escapes project root (absolute paths must be inside the project)")
		}
		return abs, nil
	}

	// Relative path: clean, anchor under root, and verify the result is still
	// inside root (reject "../" escapes).
	cleaned := filepath.Clean("/" + strings.TrimLeft(p, "/"))
	full := filepath.Join(m.root, cleaned)
	rel, err := filepath.Rel(m.root, full)
	if err != nil {
		return "", errors.New("invalid path")
	}
	if rel == "." {
		return m.root, nil
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes project root")
	}
	return full, nil
}

// rel returns a path expressed relative to the project root, with a
// leading slash, for display. Falls back to the raw full path.
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
	case "read", "read_file":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolRead(a)
	case "write", "write_file":
		var a WriteArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolWrite(a)
	case "edit", "str_replace":
		var a EditArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolEdit(a)
	case "multi_edit":
		var a MultiEditArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolMultiEdit(a)
	case "patch":
		var a PatchArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolPatch(a)
	case "mkdir":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolMkdir(a)
	case "delete", "rm":
		var a PathArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolDelete(a)
	case "rename", "move":
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
	case "list_files":
		var a ListFilesArgs
		if err := json.Unmarshal(args, &a); err != nil {
			return fail("invalid args: " + err.Error())
		}
		return m.toolListFiles(a)
	default:
		return fail("unknown tool: " + name)
	}
}

/* ------------------------------------------------------------------ *
 * Public arg structs.
 * ------------------------------------------------------------------ */

type ShellArgs struct {
	Command string `json:"command"`
	// Timeout seconds; clamped to [1, 300]. Default 120.
	Timeout int `json:"timeout,omitempty"`
}
type PathArgs struct {
	Path string `json:"path"`
}
type WriteArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type EditArgs struct {
	Path       string `json:"path"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all,omitempty"`
}
type MultiEditArgs struct {
	Path   string      `json:"path"`
	Edits  []EditArgs  `json:"edits"`
}
type PatchArgs struct {
	Patch string `json:"patch"`
}
type RenameArgs struct {
	From string `json:"from"`
	To   string `json:"to"`
}
type GlobArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path,omitempty"` // directory to search; default root
}
type GrepArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
	Max     int    `json:"max"`
}
type ListFilesArgs struct {
	Path  string `json:"path,omitempty"`  // default root
	Depth int    `json:"depth,omitempty"` // default 3
}

/* ------------------------------------------------------------------ *
 * shell — run an arbitrary shell command in the project root.
 *
 * Robustness notes:
//   - absolute paths of the project root (e.g. the cwd shown by `pwd`)
//     work as arguments because cwd IS the root, so "ls /home/.../Dg"
//     resolves to the root and lists it.
//   - stdout and stderr are kept separate and concatted with a header so
//     the model can tell them apart.
//   - output is capped to avoid blowing the context window; truncated
//     output shows a clear marker.
// ------------------------------------------------------------------ */

const shellOutputCap = 64 * 1024 // 64 KiB combined output per command

func (m *Manager) toolShell(args ShellArgs) Result {
	cmd := strings.TrimSpace(args.Command)
	if cmd == "" {
		return fail("command is required")
	}
	timeout := time.Duration(args.Timeout) * time.Second
	if timeout <= 0 || timeout > 300*time.Second {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
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
			return failf("run error: %v\n%s", err, strings.TrimSpace(errOut.String()))
		}
	}
	result := assembleShellOutput(out.String(), errOut.String(), exitCode)
	if len(result) > shellOutputCap {
		result = result[:shellOutputCap] + "\n…[output truncated]"
	}
	return ok(result)
}

func assembleShellOutput(stdout, stderr string, exitCode int) string {
	outTrim := strings.TrimSpace(stdout)
	errTrim := strings.TrimSpace(stderr)
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
	return result
}

/* ------------------------------------------------------------------ *
 * read — read a whole file.
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
		return fail("path is a directory; use ls or list_files instead")
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return fail("read error: " + cleanErr(err))
	}
	if len(b) > shellOutputCap {
		// Keep the head + a marker rather than dumping a huge file into the
		// model's context. The model can pull ranges with the shell.
		return ok(string(b[:shellOutputCap]) + "\n…[truncated; use shell + sed -n to read more lines]")
	}
	return ok(string(b))
}

/* ------------------------------------------------------------------ *
 * write — create or overwrite a file with full content.
 * ------------------------------------------------------------------ */

func (m *Manager) toolWrite(args WriteArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fail("mkdir parent: " + cleanErr(err))
	}
	// Write atomically: write to a temp then rename, so a crash mid-write
	// never leaves a half-written file. Also make the file executable if it
	// looks like a script (shebang).
	content := []byte(args.Content)
	tmp := full + ".tmp-" + randomSuffix()
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return fail("write error: " + cleanErr(err))
	}
	if err := os.Rename(tmp, full); err != nil {
		_ = os.Remove(tmp)
		return fail("write error: " + cleanErr(err))
	}
	if len(content) > 0 && strings.HasPrefix(string(content), "#!") {
		_ = os.Chmod(full, 0o755)
	}
	return ok(fmt.Sprintf("wrote %d bytes to %s", len(content), m.rel(full)))
}

/* ------------------------------------------------------------------ *
 * edit — precise in-place edit via exact string replacement.
 *
//   - old_string must match EXACTLY (including whitespace) and occur at
//     least once.
//   - To avoid editing the wrong spot, require a unique match unless
//     replace_all is set.
//   - Empty old_string is rejected (would insert arbitrarily).
//   - If new_string equals old_string the call is a no-op (but reported
//     so the model can stop looping).
// ------------------------------------------------------------------ */

func (m *Manager) toolEdit(args EditArgs) Result {
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return fail("edit error: " + cleanErr(err))
	}
	content := string(data)

	oldS := args.OldString
	newS := args.NewString
	if oldS == "" {
		return fail("old_string is required; use write to create a file")
	}
	if oldS == newS {
		return ok("no change (old_string == new_string): " + m.rel(full))
	}

	occurrences := strings.Count(content, oldS)
	if occurrences == 0 {
		// Help the model recover by showing nearby lines for the first
		// regex-ish fragment of old_string. This is enormously useful in
		// practice when whitespace differs.
		return failf("old_string not found in %s. Make sure it appears verbatim (indentation/blank lines exactly). Suggestion: re-read the file and copy the exact text.", m.rel(full))
	}
	if occurrences > 1 && !args.ReplaceAll {
		return failf("old_string occurs %d times in %s. Pass replace_all=true to replace every occurrence, or include more surrounding context so it's unique.", occurrences, m.rel(full))
	}

	var updated string
	if args.ReplaceAll {
		updated = strings.ReplaceAll(content, oldS, newS)
	} else {
		updated = strings.Replace(content, oldS, newS, 1)
	}

	if err := os.WriteFile(full, []byte(updated), 0o644); err != nil {
		return fail("write error: " + cleanErr(err))
	}
	n := occurrences
	if !args.ReplaceAll {
		n = 1
	}
	return ok(fmt.Sprintf("edited %s: replaced %d occurrence(s)", m.rel(full), n))
}

/* ------------------------------------------------------------------ *
 * multi_edit — apply several edits to one file in a single call.
 *
//   - Each edit is applied in order; later edits see earlier edits.
//   - All edits must succeed or the file is left unmodified (TransactionLike).
// ------------------------------------------------------------------ */

func (m *Manager) toolMultiEdit(args MultiEditArgs) Result {
	if len(args.Edits) == 0 {
		return fail("at least one edit is required")
	}
	full, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return fail("read error: " + cleanErr(err))
	}
	content := string(data)

	applied := 0
	// Pre-validate every edit so we don't apply a partial batch.
	for i, e := range args.Edits {
		if e.OldString == "" {
			return failf("edit #%d: old_string is required", i+1)
		}
		if strings.Count(content, e.OldString) == 0 {
			return failf("edit #%d: old_string not found in %s", i+1, m.rel(full))
		}
		if strings.Count(content, e.OldString) > 1 && !e.ReplaceAll {
			return failf("edit #%d: old_string is not unique in %s (found %d). Add context or set replace_all=true.", i+1, m.rel(full), strings.Count(content, e.OldString))
		}
		// Apply sequentially so later edits match the post-edit text.
		if e.ReplaceAll {
			content = strings.ReplaceAll(content, e.OldString, e.NewString)
		} else {
			content = strings.Replace(content, e.OldString, e.NewString, 1)
		}
		applied++
	}

	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		return fail("write error: " + cleanErr(err))
	}
	return ok(fmt.Sprintf("multi_edit: applied %d edit(s) to %s", applied, m.rel(full)))
}

/* ------------------------------------------------------------------ *
 * patch — apply a unified diff against the project tree.
 *
//   - Standard `diff -u` hunk format:
//       --- a/path
//       +++ b/path
//       @@ -L,N +L,N @@
//        context
//       -removed
//       +added
//   - Only one file per patch (multi-file patches may be added later).
//   - The file path is taken from the +++ header (b/ prefix stripped).
// ------------------------------------------------------------------ */

func (m *Manager) toolPatch(args PatchArgs) Result {
	patch := strings.TrimSpace(args.Patch)
	if patch == "" {
		return fail("patch is required")
	}
	// Parse headers to find the target file.
	lines := strings.Split(patch, "\n")
	if len(lines) < 2 {
		return fail("invalid patch: too short")
	}
	var target string
	for _, ln := range lines {
		if strings.HasPrefix(ln, "+++ ") {
			t := strings.TrimSpace(strings.TrimPrefix(ln, "+++ "))
			t = strings.TrimPrefix(t, "b/")
			if i := strings.IndexByte(t, '\t'); i >= 0 {
				t = t[:i]
			}
			target = t
			break
		}
	}
	if target == "" {
		return fail("could not determine target file from patch header")
	}
	// Best-effort: write the patch to a temp file and call `patch -p1` in
	// the project root, which handles real unified diffs (line offsets,
	// fuzz, etc.) far more robustly than a hand-rolled applier. Fall back
	// to a manual apply if `patch` isn't available.
	patchPath := filepath.Join(m.root, ".kscode-agent.patch")
	if err := os.WriteFile(patchPath, []byte(patch), 0o600); err != nil {
		return fail("write patch tmp: " + cleanErr(err))
	}
	defer os.Remove(patchPath)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, "patch", "-p1", "--no-backup-if-mismatch", "-i", patchPath)
	c.Dir = m.root
	var out, errOut bytes.Buffer
	c.Stdout = &out
	c.Stderr = &errOut
	if err := c.Run(); err != nil {
		// If `patch` is missing, fall back to a manual applier.
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 127 {
			return manualApplyPatch(m, target, patch)
		}
		return failf("patch failed: %v\n%s\n%s", err, strings.TrimSpace(out.String()), strings.TrimSpace(errOut.String()))
	}
	return ok(fmt.Sprintf("patched %s\n%s", target, strings.TrimSpace(out.String())))
}

// manualApplyPatch is a minimal fallback when GNU `patch` is unavailable.
// Only handles single-file hunks with exact context.
func manualApplyPatch(m *Manager, target, patch string) Result {
	full, err := m.resolve(target)
	if err != nil {
		return fail(err.Error())
	}
	data, rerr := os.ReadFile(full)
	if rerr != nil {
		return fail("read target: " + cleanErr(rerr))
	}
	fileLines := strings.Split(string(data), "\n")

	// Collect hunks. A hunk starts with "@@".
	type hunk struct {
		startline int
		body      []string // lines after the @@ header
	}
	var hunks []hunk
	for i, ln := range strings.Split(patch, "\n") {
		if strings.HasPrefix(ln, "@@") {
			h := hunk{
				startline: parseHunkStart(ln),
				body:      []string{},
			}
			// grab subsequent body lines until blank or next @@
			for _, bl := range strings.Split(patch, "\n")[i+1:] {
				if strings.HasPrefix(bl, "@@") || bl == "" {
					break
				}
				h.body = append(h.body, bl)
			}
			hunks = append(hunks, h)
		}
	}
	if len(hunks) == 0 {
		return fail("manual apply: no hunks parsed")
	}
	// Apply hunks in order against the file lines. This is a naive
	// exact-context applier — the user is much better off with GNU patch.
	for _, h := range hunks {
		idx := h.startline - 1
		if idx < 0 {
			idx = 0
		}
		// Walk the hunk body rebuilding this region.
		var rebuilt []string
		matched := 0
		for _, bl := range h.body {
			switch {
			case strings.HasPrefix(bl, "-"):
				// Removal: confirm the line matches, drop it.
				if idx < len(fileLines) && fileLines[idx] == strings.TrimPrefix(bl, "-") {
					idx++
					matched++
				}
			case strings.HasPrefix(bl, "+"):
				rebuilt = append(rebuilt, strings.TrimPrefix(bl, "+"))
			default:
				// Context line: keep it, advance.
				if idx < len(fileLines) && fileLines[idx] == strings.TrimPrefix(bl, " ") {
					rebuilt = append(rebuilt, fileLines[idx])
					idx++
					matched++
				}
			}
		}
		if matched == 0 {
			return fail("manual apply: context mismatch (install GNU patch for robustness)")
		}
		// Splice rebuilt region. For simplicity treat it as a contiguous
		// replace from the original start to current idx.
		start := h.startline - 1
		if start < 0 {
			start = 0
		}
		fileLines = append(append(append([]string{}, fileLines[:start]...), rebuilt...), fileLines[idx:]...)
	}
	if werr := os.WriteFile(full, []byte(strings.Join(fileLines, "\n")), 0o644); werr != nil {
		return fail("write after manual patch: " + cleanErr(werr))
	}
	return ok("patch applied (manual fallback) to " + m.rel(full))
}

func parseHunkStart(header string) int {
	// Header looks like: @@ -10,7 +10,8 @@
	i := strings.Index(header, "-")
	if i < 0 {
		return 1
	}
	rest := header[i+1:]
	j := strings.IndexAny(rest, ", \t")
	if j < 0 {
		return 1
	}
	n := 0
	for k := 0; k < j && k < len(rest); k++ {
		if rest[k] < '0' || rest[k] > '9' {
			break
		}
		n = n*10 + int(rest[k]-'0')
	}
	if n <= 0 {
		return 1
	}
	return n
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
 * rename / move
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
 * glob — find files by glob pattern (supports **).
//   - A leading path arg scopes the search; default root.
//   - Results are returned as project-relative paths with a leading slash.
 * ------------------------------------------------------------------ */

func (m *Manager) toolGlob(args GlobArgs) Result {
	pattern := strings.TrimSpace(args.Pattern)
	if pattern == "" {
		pattern = "**/*"
	}
	searchRoot, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	info, err := os.Stat(searchRoot)
	if err != nil {
		return fail("glob error: " + cleanErr(err))
	}
	if !info.IsDir() {
		searchRoot = filepath.Dir(searchRoot)
	}
	relPattern := strings.TrimPrefix(pattern, "/")
	matches, err := doublestarGlob(searchRoot, relPattern)
	if err != nil {
		return fail("glob error: " + err.Error())
	}
	if len(matches) == 0 {
		return ok("no matches")
	}
	if len(matches) > 1000 {
		matches = matches[:1000]
		return ok(strings.Join(matches, "\n") + "\n…[truncated to 1000 matches]")
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
			// Match directories too so patterns like "src/**/controllers" work.
			rel, _ := filepath.Rel(root, path)
			rel = filepath.ToSlash(rel)
			if rel != "." && matchDoubleStar(rel, pattern) {
				results = append(results, "/"+rel+"/")
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
 * grep — search file contents with a regex.
//   - path may be a file or directory (root by default).
//   - pattern is a Go regex; if it fails to compile, treated as literal.
//   - returns {path,line,preview}; capped by max.
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
				preview := strings.TrimSpace(line)
				if len(preview) > 200 {
					preview = preview[:200] + "…"
				}
				hits = append(hits, grepHit{
					Path:    m.rel(path),
					Line:    i + 1,
					Preview: preview,
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
 * ls — list a single directory (names; dirs suffixed with /).
//   - Now also accepts absolute paths equal to the project root and lists
//     them correctly (the old bug produced <root>/<root>/... errors).
//   - Shows entry count and marks dirs.
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
	count := 0
	dirs := 0
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if e.IsDir() {
			sb.WriteString(name + "/\n")
			dirs++
		} else {
			sb.WriteString(name + "\n")
		}
		count++
	}
	result := strings.TrimSpace(sb.String())
	if result == "" {
		result = "(empty)"
	} else {
		// Append a small footer so the model knows the directory shape.
		result = fmt.Sprintf("%s\n\n(%d entries: %d dir, %d file)", result, count, dirs, count-dirs)
	}
	return ok(result)
}

/* ------------------------------------------------------------------ *
 * list_files — a more structured recursive listing with file sizes/types.
 * Useful when the model needs an overview of a subtree without slurping
// every file via `read`.
 * ------------------------------------------------------------------ */

type listNode struct {
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size,omitempty"`
}

func (m *Manager) toolListFiles(args ListFilesArgs) Result {
	searchRoot, err := m.resolve(args.Path)
	if err != nil {
		return fail(err.Error())
	}
	info, err := os.Stat(searchRoot)
	if err != nil {
		return fail("list_files error: " + cleanErr(err))
	}
	if !info.IsDir() {
		return fail("list_files expects a directory")
	}
	depth := args.Depth
	if depth <= 0 {
		depth = 3
	}
	nodes := make([]listNode, 0, 64)
	skipDirs := map[string]bool{".git": true, "node_modules": true, "dist": true, "build": true}
	_ = filepath.WalkDir(searchRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(searchRoot, path)
		rel = filepath.ToSlash(rel)
		depthFromRoot := strings.Count(rel, "/")
		if d.IsDir() {
			if rel != "." && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			// Stop descending past depth for non-root dirs.
			if depthFromRoot >= depth && rel != "." {
				return fs.SkipDir
			}
			if rel != "." {
				inf, _ := d.Info()
				size := int64(0)
				if inf != nil {
					size = inf.Size()
				}
				nodes = append(nodes, listNode{Path: m.rel(path), IsDir: true, Size: size})
			}
			return nil
		}
		inf, _ := d.Info()
		size := int64(0)
		if inf != nil {
			size = inf.Size()
		}
		nodes = append(nodes, listNode{Path: m.rel(path), IsDir: false, Size: size})
		return nil
	})
	if len(nodes) > 1000 {
		nodes = nodes[:1000]
	}
	if len(nodes) == 0 {
		return ok("(empty)")
	}
	b, _ := json.Marshal(nodes)
	return ok(string(b))
}

/* ------------------------------------------------------------------ *
 * Small helpers.
 * ------------------------------------------------------------------ */

func cleanErr(err error) string { return err.Error() }

func randomSuffix() string {
	// 6 hex chars from the time is enough for a unique temp suffix here.
	return fmt.Sprintf("%x", time.Now().UnixNano()&0xffffff)
}