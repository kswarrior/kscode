// Package agent implements the background task management for agentic runs.
// Tasks run in the background and can be reconnected to via SSE.
package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"kscode/internal/llm"
	"kscode/internal/tools"
)

// TaskStatus represents the state of a background agent task.
type TaskStatus string

const (
	TaskStatusPending   TaskStatus = "pending"
	TaskStatusRunning   TaskStatus = "running"
	TaskStatusCompleted TaskStatus = "completed"
	TaskStatusStopped   TaskStatus = "stopped"
	TaskStatusError     TaskStatus = "error"
)

// TaskEvent is an event emitted during task execution, stored for replay on reconnection.
type TaskEvent struct {
	Event     Event     `json:"event"`
	Timestamp time.Time `json:"timestamp"`
}

// BackgroundTask represents a long-running agent task.
type BackgroundTask struct {
	ID          string
	Provider    string
	Model       string
	System      string
	Cwd         string
	Messages    []llm.Message
	MaxRounds   int
	Status      TaskStatus
	Events      []TaskEvent
	FinalText   string
	Error       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	CancelFunc  context.CancelFunc `json:"-"`
	mu          sync.Mutex
}

func (t *BackgroundTask) AddEvent(ev Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Events = append(t.Events, TaskEvent{Event: ev, Timestamp: time.Now()})
	t.UpdatedAt = time.Now()
}

func (t *BackgroundTask) SetStatus(status TaskStatus) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Status = status
	t.UpdatedAt = time.Now()
}

func (t *BackgroundTask) SetFinalText(text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.FinalText = text
	t.UpdatedAt = time.Now()
}

func (t *BackgroundTask) SetError(err string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Error = err
	t.UpdatedAt = time.Now()
}

func (t *BackgroundTask) GetEventsSince(index int) []TaskEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	if index < 0 || index >= len(t.Events) {
		return nil
	}
	return t.Events[index:]
}

func (t *BackgroundTask) GetAllEvents() []TaskEvent {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]TaskEvent{}, t.Events...)
}

func (t *BackgroundTask) GetStatus() TaskStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Status
}

// TaskManager manages background agent tasks.
type TaskManager struct {
	tasks map[string]*BackgroundTask
	mu    sync.RWMutex
}

func NewTaskManager() *TaskManager {
	return &TaskManager{tasks: make(map[string]*BackgroundTask)}
}

func (m *TaskManager) CreateTask(cfg RunConfig) *BackgroundTask {
	_, cancel := context.WithCancel(context.Background())
	task := &BackgroundTask{
		ID:        generateTaskID(),
		Provider:  cfg.Provider,
		Model:     cfg.Model,
		System:    cfg.System,
		Cwd:       cfg.Cwd,
		Messages:  cfg.Messages,
		MaxRounds: cfg.MaxRounds,
		Status:    TaskStatusPending,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		CancelFunc: cancel,
	}
	m.mu.Lock()
	m.tasks[task.ID] = task
	m.mu.Unlock()
	return task
}

func (m *TaskManager) GetTask(id string) (*BackgroundTask, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t, ok := m.tasks[id]
	return t, ok
}

func (m *TaskManager) DeleteTask(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.tasks, id)
}

func (m *TaskManager) ListTasks() []*BackgroundTask {
	m.mu.RLock()
	defer m.mu.RUnlock()
	tasks := make([]*BackgroundTask, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, t)
	}
	return tasks
}

// StartTask runs the agent in the background, emitting events to the task.
func (m *TaskManager) StartTask(task *BackgroundTask, llmClient *llm.Client) {
	task.SetStatus(TaskStatusRunning)
	task.AddEvent(Event{Tag: EventThinking, Round: 1})

	go func() {
		defer func() {
			if r := recover(); r != nil {
				task.SetError(fmt.Sprintf("panic: %v", r))
				task.SetStatus(TaskStatusError)
			}
			task.CancelFunc()
		}()

		cfg := RunConfig{
			Provider:  task.Provider,
			Model:     task.Model,
			System:    task.System,
			Cwd:       task.Cwd,
			Messages:  task.Messages,
			MaxRounds: task.MaxRounds,
		}

		ctx, cancel := context.WithCancel(context.Background())
		task.CancelFunc = cancel

		var finalText string
		_, err := RunWithContext(ctx, llmClient, cfg, func(ev Event) {
			task.AddEvent(ev)
			if ev.Tag == EventAssistantDelta && ev.Delta != "" {
				finalText += ev.Delta
			}
			if ev.Tag == EventDone {
				task.SetFinalText(finalText)
				task.SetStatus(TaskStatusCompleted)
			}
			if ev.Tag == EventError && ev.Error != "" {
				task.SetError(ev.Error)
				task.SetStatus(TaskStatusError)
			}
		})

		if err != nil && task.GetStatus() == TaskStatusRunning {
			task.SetError(err.Error())
			task.SetStatus(TaskStatusError)
		}
	}()
}

func (m *TaskManager) StopTask(id string) bool {
	m.mu.RLock()
	task, ok := m.tasks[id]
	m.mu.RUnlock()
	if !ok {
		return false
	}
	if task.CancelFunc != nil {
		task.CancelFunc()
	}
	task.SetStatus(TaskStatusStopped)
	task.AddEvent(Event{Tag: EventDone, Error: "stopped by user"})
	return true
}

func generateTaskID() string {
	return fmt.Sprintf("task-%d-%s", time.Now().UnixNano(), randomString(8))
}

func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[time.Now().UnixNano()%int64(len(letters))]
		time.Sleep(time.Nanosecond)
	}
	return string(b)
}

// RunWithContext is like Run but accepts an externally controlled context.
// It shares the same agentic loop as Run but will bail immediately when the
// context is cancelled (used by background tasks so Stop works).
func RunWithContext(ctx context.Context, llmClient *llm.Client, cfg RunConfig, onEvent func(Event)) (string, error) {
	if llmClient == nil {
		return "", fmt.Errorf("llm client required")
	}
	maxRounds := cfg.MaxRounds
	if maxRounds <= 0 {
		maxRounds = 50
	}
	system := cfg.System
	if system == "" {
		system = SystemPrompt
	}

	mgr := tools.NewManager(cfg.Cwd)

	msgs := make([]llm.Message, 0, len(cfg.Messages)+4)
	msgs = append(msgs, llm.Message{Role: "system", Content: system})
	msgs = append(msgs, cfg.Messages...)

	var finalText strings.Builder

	for round := 1; round <= maxRounds; round++ {
		select {
		case <-ctx.Done():
			return finalText.String(), ctx.Err()
		default:
		}

		safeEmit(onEvent, Event{Tag: EventThinking, Round: round})

		var acc strings.Builder
		req := llm.ChatRequest{
			Provider: cfg.Provider,
			Model:    cfg.Model,
			Stream:   true,
			Messages: msgs,
		}

		// Use the shared retry-aware streamer for robustness on transient errors.
		streamErr := streamWithRetry(ctx, llmClient, req, round, func(d llm.Delta) {
			if d.Delta != "" {
				acc.WriteString(d.Delta)
				safeEmit(onEvent, Event{Tag: EventAssistantDelta, Round: round, Delta: d.Delta})
			}
		}, onEvent)
		if streamErr != nil {
			// streamWithRetry already emitted an EventError; bail out.
			return finalText.String(), streamErr
		}

		assistantText := acc.String()
		finalText.WriteString(assistantText)

		msgs = append(msgs, llm.Message{Role: "assistant", Content: assistantText})

		calls := parseToolCalls(assistantText)
		if len(calls) == 0 {
			// No parseable tool calls. If the model emitted a tool_call block
			// but it was malformed, give feedback so it can self-correct
			// instead of ending the loop prematurely.
			if hasToolCallBlock(assistantText) {
				safeEmit(onEvent, Event{Tag: EventToolRequest, Round: round, Tool: &ToolCall{
					ID:   fmt.Sprintf("r%d-tmalformed", round),
					Name: "malformed_tool_call",
				}})
				tr := ToolResult{
					ID:     fmt.Sprintf("r%d-tmalformed", round),
					Name:   "malformed_tool_call",
					OK:     false,
					Output: "Your tool_call block was detected but the JSON was malformed or missing a 'name'. Emit ONE tool_call block with valid JSON: {\"name\":\"<tool>\",\"args\":{...}}",
				}
				safeEmit(onEvent, Event{Tag: EventToolResult, Round: round, Result: &tr})
				msgs = append(msgs, llm.Message{
					Role:    "user",
					Content: "Your previous tool_call block was malformed or had no 'name'. Re-emit a valid tool_call block in the exact format:\n```tool_call\n{\"name\":\"read\",\"args\":{\"path\":\"src/app.js\"}}\n```\nContinue the task.",
				})
				continue
			}
			// Genuinely done — no tool blocks at all.
			safeEmit(onEvent, Event{Tag: EventDone, Round: round})
			return finalText.String(), nil
		}

		var resultBlock strings.Builder
		for i, c := range calls {
			c.ID = fmt.Sprintf("r%d-t%d", round, i+1)
			safeEmit(onEvent, Event{Tag: EventToolRequest, Round: round, Tool: &c, Text: assistantText})

			res := mgr.Call(c.Name, c.Args)
			tr := ToolResult{
				ID:     c.ID,
				Name:   c.Name,
				OK:     res.OK,
				Output: res.Output,
			}
			safeEmit(onEvent, Event{Tag: EventToolResult, Round: round, Result: &tr})

			resultBlock.WriteString(fmt.Sprintf("tool_result %s (%s) ok=%v:\n%s\n\n", c.ID, c.Name, res.OK, res.Output))
		}

		msgs = append(msgs, llm.Message{
			Role:    "user",
			Content: "Here are the tool results. Continue the task — verify, then either call more tools or give a final prose summary.\n\n" + resultBlock.String(),
		})
	}

	safeEmit(onEvent, Event{Tag: EventDone, Round: maxRounds, Error: "max rounds reached"})
	return finalText.String(), nil
}