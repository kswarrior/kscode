package agent

import "testing"

// Reproduces the user-reported case: the model printed the write tool_call
// with the EJS content string containing LITERAL newlines (real \n bytes),
// not escaped \\n. Strict JSON rejected it, so the file was not written and
// the raw JSON+EJS leaked into the chat as text.
func TestExtractToolFromJSON_LiteralNewlinesInContent(t *testing.T) {
	raw := "{ \"name\": \"write\", \"args\": { \"path\": \"views/index.ejs\", \"content\": \"<%- include('partials/header') %>\n\nDashboard\nWelcome.\n\n\n\n© 2024 KS Warrior\n\n\n</footer>\" } }"
	c, ok := extractToolFromJSON(raw)
	if !ok {
		t.Fatalf("expected lenient extract to succeed on literal-newline content")
	}
	if c.Name != "write" {
		t.Fatalf("expected name=write, got %q", c.Name)
	}
}

func TestParseToolCalls_BareWriteWithMultiLineLiteralContent(t *testing.T) {
	text := "I'll write the dashboard view.\n{ \"name\": \"write\", \"args\": { \"path\": \"views/index.ejs\", \"content\": \"line1\nline2\nline3\" } }\nThe file is created."
	calls := parseToolCalls(text)
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(calls))
	}
	if calls[0].Name != "write" {
		t.Fatalf("expected write, got %q", calls[0].Name)
	}
}

func TestHasToolCallBlock_BareWithLiteralNewlines(t *testing.T) {
	text := "prefix { \"name\":\"read\",\"args\":{\"path\":\"x\"} } suffix"
	if !hasToolCallBlock(text) {
		t.Fatal("expected to detect bare inline tool block")
	}
}
