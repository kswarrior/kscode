package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

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
}

type ChatResponse struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Content  string `json:"content"`
	Raw      string `json:"raw,omitempty"`
}

type Client struct {
	store *settings.Store
	http  *http.Client
}

func NewClient(store *settings.Store) *Client {
	return &Client{
		store: store,
		http:  &http.Client{Timeout: 90 * time.Second},
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
	if provider.APIKey == "" {
		return nil, errors.New("provider api key not configured")
	}
	switch provider.ID {
	case "gemini":
		return c.gemini(ctx, provider, req)
	default:
		return c.openAICompat(ctx, provider, req)
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
		req.Model = "meta/llama-3.1-70b-instruct"
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
		req.Model = "gemini-1.5-flash"
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
