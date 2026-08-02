package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"kscode/internal/settings"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Provider  string    `json:"provider"`
	Model     string    `json:"model"`
	Messages  []Message `json:"messages"`
	MaxTokens int       `json:"maxTokens,omitempty"`
	Stream    bool      `json:"stream,omitempty"`
}

type ChatResponse struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Content  string `json:"content"`
	Raw      string `json:"raw,omitempty"`
}

// Delta is one chunk of streamed content. Done=true marks the end.
type Delta struct {
	Delta    string `json:"delta,omitempty"`
	Done     bool   `json:"done"`
	Error    string `json:"error,omitempty"`
}

type Client struct {
	store *settings.Store
	http  *http.Client
}

func NewClient(store *settings.Store) *Client {
	// No overall timeout: streaming responses may take a while; per-request
	// context cancellation is handled by the HTTP handler.
	return &Client{
		store: store,
		http:  &http.Client{},
	}
}

func (c *Client) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	if req.Provider == "" {
		return nil, errors.New("provider required")
	}
	provider, ok := c.findProvider(req.Provider)
	if !ok {
		return nil, errors.New("unknown provider")
	}
	// Fall back to an environment-variable API key when none is stored in settings,
	// so the tool works out of the box if the user exports the key.
	if provider.APIKey == "" {
		provider.APIKey = os.Getenv(provider.ID + "_API_KEY")
	}
	if provider.APIKey == "" {
		return nil, fmt.Errorf("provider %s api key not configured (set it in Settings or export %s_API_KEY)", provider.ID, strings.ToUpper(provider.ID))
	}
	switch provider.ID {
	case "gemini":
		return c.gemini(ctx, provider, req)
	default:
		return c.openAICompat(ctx, provider, req)
	}
}

// StreamChat streams incremental content chunks to the provided callback.
// Both OpenAI-compatible servers (SSE data: lines) and Gemini
// (streamGenerateContent with alt=sse) are supported.
func (c *Client) StreamChat(ctx context.Context, req ChatRequest, onDelta func(Delta)) error {
	if req.Provider == "" {
		return errors.New("provider required")
	}
	provider, ok := c.findProvider(req.Provider)
	if !ok {
		return errors.New("unknown provider")
	}
	if provider.APIKey == "" {
		provider.APIKey = os.Getenv(provider.ID + "_API_KEY")
	}
	if provider.APIKey == "" {
		return fmt.Errorf("provider %s api key not configured (set it in Settings or export %s_API_KEY)", provider.ID, strings.ToUpper(provider.ID))
	}
	switch provider.ID {
	case "gemini":
		return c.geminiStream(ctx, provider, req, onDelta)
	default:
		return c.openAIStream(ctx, provider, req, onDelta)
	}
}

func (c *Client) findProvider(id string) (settings.Provider, bool) {
	all := c.store.Get()
	for _, p := range all.AI.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return settings.Provider{}, false
}

func (c *Client) openAICompat(ctx context.Context, p settings.Provider, req ChatRequest) (*ChatResponse, error) {
	if req.Model == "" {
		if len(p.Models) > 0 {
			req.Model = p.Models[0]
		} else {
			req.Model = "meta/llama-3.1-70b-instruct"
		}
	}
	body := map[string]any{
		"model":    req.Model,
		"messages": req.Messages,
	}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(p.BaseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("provider %s returned %d: %s", p.ID, resp.StatusCode, string(raw))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	content := ""
	if len(parsed.Choices) > 0 {
		content = parsed.Choices[0].Message.Content
	}
	return &ChatResponse{Provider: p.ID, Model: req.Model, Content: content, Raw: string(raw)}, nil
}

func (c *Client) gemini(ctx context.Context, p settings.Provider, req ChatRequest) (*ChatResponse, error) {
	if req.Model == "" {
		if len(p.Models) > 0 {
			req.Model = p.Models[0]
		} else {
			req.Model = "gemini-1.5-flash"
		}
	}
	parts := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		role := m.Role
		if role == "system" {
			role = "user"
		}
		parts = append(parts, map[string]any{
			"role": role,
			"parts": []map[string]any{
				{"text": m.Content},
			},
		})
	}
	body := map[string]any{"contents": parts}
	b, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s", strings.TrimRight(p.BaseURL, "/"), req.Model, p.APIKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("gemini returned %d: %s", resp.StatusCode, string(raw))
	}
	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	content := ""
	if len(parsed.Candidates) > 0 {
		for _, part := range parsed.Candidates[0].Content.Parts {
			content += part.Text
		}
	}
	return &ChatResponse{Provider: p.ID, Model: req.Model, Content: content, Raw: string(raw)}, nil
}

// openAIStream forwards an OpenAI-compatible streaming chat completion
// and emits each content delta through onDelta.
func (c *Client) openAIStream(ctx context.Context, p settings.Provider, req ChatRequest, onDelta func(Delta)) error {
	if req.Model == "" {
		if len(p.Models) > 0 {
			req.Model = p.Models[0]
		} else {
			req.Model = "meta/llama-3.1-70b-instruct"
		}
	}
	body := map[string]any{
		"model":    req.Model,
		"messages": req.Messages,
		"stream":   true,
	}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(p.BaseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("provider %s returned %d: %s", p.ID, resp.StatusCode, string(raw))
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var ev struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}
		if len(ev.Choices) > 0 && ev.Choices[0].Delta.Content != "" {
			onDelta(Delta{Delta: ev.Choices[0].Delta.Content})
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	onDelta(Delta{Done: true})
	return nil
}

// geminiStream forwards a Gemini streamGenerateContent call (alt=sse) and
// emits each text part through onDelta.
func (c *Client) geminiStream(ctx context.Context, p settings.Provider, req ChatRequest, onDelta func(Delta)) error {
	if req.Model == "" {
		if len(p.Models) > 0 {
			req.Model = p.Models[0]
		} else {
			req.Model = "gemini-1.5-flash"
		}
	}
	parts := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		role := m.Role
		if role == "system" {
			role = "user"
		}
		parts = append(parts, map[string]any{
			"role": role,
			"parts": []map[string]any{
				{"text": m.Content},
			},
		})
	}
	body := map[string]any{"contents": parts}
	b, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/models/%s:streamGenerateContent?alt=sse&key=%s", strings.TrimRight(p.BaseURL, "/"), req.Model, p.APIKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("gemini returned %d: %s", resp.StatusCode, string(raw))
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var ev struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}
		if len(ev.Candidates) > 0 {
			for _, part := range ev.Candidates[0].Content.Parts {
				if part.Text != "" {
					onDelta(Delta{Delta: part.Text})
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	onDelta(Delta{Done: true})
	return nil
}
