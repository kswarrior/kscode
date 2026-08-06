package agent

import "testing"

func TestParseBareInline_MultiLineArgs(t *testing.T) {
	// The exact failure case from the user: model writes the write tool call
	// inline with a multi-line content arg (the views/index.ejs block).
	text := `Now I'll create the dashboard view.

{ "name": "write", "args": { "path": "views/index.ejs", "content": "<%- include('partials/header') %>\n\n<section>\n  <h1>Dashboard</h1>\n  <p>Welcome to the KS Warrior website dashboard.</p>\n  <p>Use the navigation to explore the site.</p>\n</section>\n\n<footer>\n\n\n© 2024 KS Warrior Website\n\n\n</footer>" } }

Done creating the file.`
	calls := parseToolCalls(text)
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d: %+v", len(calls), calls)
	}
	if calls[0].Name != "write" {
		t.Fatalf("expected name=write, got %q", calls[0].Name)
	}
}

func TestParseBareInline_MidLine(t *testing.T) {
	// Inline, mid-sentence, not anchored to line start.
	text := `I will now write the file {"name":"write","args":{"path":"src/app.js","content":"x"}} and verify.`
	calls := parseToolCalls(text)
	if len(calls) != 1 || calls[0].Name != "write" {
		t.Fatalf("expected write, got %+v", calls)
	}
}

func TestCanonicalFenceStillWorks(t *testing.T) {
	text := "```tool_call\n{\"name\":\"ls\",\"args\":{\"path\":\".\"}}\n```"
	calls := parseToolCalls(text)
	if len(calls) != 1 || calls[0].Name != "ls" {
		t.Fatalf("expected ls, got %+v", calls)
	}
}

func TestHasToolCallBlockBare(t *testing.T) {
	if !hasToolCallBlock(`prefix {"name":"read","args":{"path":"x"}} suffix`) {
		t.Fatal("expected to detect bare inline tool block")
	}
}
