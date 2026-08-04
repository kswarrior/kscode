package tools

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAbsolutePathUnderRoot(t *testing.T) {
	root, err := os.MkdirTemp("", "kscode-root-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(root)
	abs, _ := filepath.Abs(root)
	m := NewManager(abs)

	// 1) Relative path resolves under root.
	p, err := m.resolve("src/app.js")
	if err != nil {
		t.Fatalf("resolve relative: %v", err)
	}
	if p != filepath.Join(abs, "src/app.js") {
		t.Fatalf("got %q want %q", p, filepath.Join(abs, "src/app.js"))
	}

	// 2) Absolute path equal to the project root resolves to the root,
	//    NOT root+root (the old doubling bug).
	p, err = m.resolve(abs)
	if err != nil {
		t.Fatalf("resolve abs=root: %v", err)
	}
	if p != abs {
		t.Fatalf("got %q want %q (doubling bug)", p, abs)
	}

	// 3) Absolute path inside root resolves to that same path.
	inside := filepath.Join(abs, "src/app.js")
	p, err = m.resolve(inside)
	if err != nil {
		t.Fatalf("resolve abs=inside: %v", err)
	}
	if p != inside {
		t.Fatalf("got %q want %q", p, inside)
	}

	// 4) Absolute path OUTSIDE root is rejected.
	p, err = m.resolve("/etc/passwd")
	if err == nil {
		t.Fatalf("expected error for /etc/passwd, got %q", p)
	}
}
