package shell

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type Event struct {
	Type    string `json:"type"`
	Stream  string `json:"stream,omitempty"`
	Data    string `json:"data,omitempty"`
	Exit    int    `json:"exit,omitempty"`
	Error   string `json:"error,omitempty"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	PID     int    `json:"pid,omitempty"`
	Started string `json:"started,omitempty"`
	Ended   string `json:"ended,omitempty"`
}

type Session struct {
	ID         string
	Cmd        *exec.Cmd
	master     *os.File // PTY master end (also used for stdin writes)
	closed     atomic.Bool
	closeOnce  sync.Once
	rows       int
	cols       int
	cwd        string
	name       string
	cancel     context.CancelFunc
	listeners  []chan Event
	listenerMu sync.RWMutex
	env        []string
	// history retains recent output so a client connecting slightly after
	// the PTY started doesn't miss the initial prompt/output.
	history []Event
}

type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

// SessionInfo is a lightweight description of a session for listing.
type SessionInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Cwd   string `json:"cwd"`
	PID   int    `json:"pid"`
	Alive bool   `json:"alive"`
}

// List returns a snapshot of all current sessions.
func (m *Manager) List() []SessionInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		s.listenerMu.RLock()
		name := s.name
		s.listenerMu.RUnlock()
		pid := 0
		if s.Cmd != nil && s.Cmd.Process != nil {
			pid = s.Cmd.Process.Pid
		}
		out = append(out, SessionInfo{
			ID:    s.ID,
			Name:  name,
			Cwd:   s.cwd,
			PID:   pid,
			Alive: !s.closed.Load(),
		})
	}
	return out
}

// SetName updates the displayed name of a session.
func (m *Manager) SetName(id, name string) bool {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return false
	}
	s.listenerMu.Lock()
	s.name = name
	s.listenerMu.Unlock()
	return true
}

// Kill stops a session by ID (sends SIGKILL to the process and removes it).
func (m *Manager) Kill(id string) bool {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return false
	}
	s.Close()
	m.remove(id)
	return true
}

func (m *Manager) add(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[s.ID] = s
}

func (m *Manager) remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, id)
}

type StartOptions struct {
	Cwd   string
	Cols  int
	Rows  int
	Shell string
	Env   []string
	Name  string
}

func (m *Manager) Start(id string, opts StartOptions) (*Session, error) {
	shell := opts.Shell
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		shell = "/bin/bash"
	}
	if _, err := exec.LookPath(shell); err != nil {
		return nil, errors.New("shell not found: " + shell)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, shell)
	cmd.Env = append(os.Environ(), opts.Env...)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}

	// Allocate a pseudo-terminal so the shell runs interactively (prompts,
	// line editing, echoing input, TUI programs like vim/top all work).
	master, slavePath, err := openPTY()
	if err != nil {
		cancel()
		return nil, errors.New("pty alloc failed: " + err.Error())
	}

	// Initial window size so bash and the prompt render at the right width.
	if opts.Cols > 0 && opts.Rows > 0 {
		_ = setWinSize(master, opts.Rows, opts.Cols)
	}

	// Wire the slave end of the PTY as the child's stdin/stdout/stderr.
	// Opening the slave with O_RDWR gives us one fd for all three.
	slave, err := os.OpenFile(slavePath, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		master.Close()
		cancel()
		return nil, errors.New("open slave pty failed: " + err.Error())
	}
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave

	// Make the slave the child's controlling terminal so job control and
	// signals (Ctrl-C, Ctrl-Z) behave like a real terminal. SysProcAttr is
	// platform-specific; on Linux this sets the controlling tty to the slave.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
		Ctty:    0, // child's stdin (fd 0) is the slave tty
	}

	if err := cmd.Start(); err != nil {
		slave.Close()
		master.Close()
		cancel()
		return nil, err
	}
	// The child has its own dup of the slave fd now; close our copy so
	// writing EOF / detecting exit works correctly.
	slave.Close()

	sess := &Session{
		ID:     id,
		Cmd:    cmd,
		master: master,
		rows:   opts.Rows,
		cols:   opts.Cols,
		cwd:    cmd.Dir,
		name:   opts.Name,
		cancel: cancel,
		env:    opts.Env,
	}
	sess.emit(Event{
		Type:    "start",
		PID:     cmd.Process.Pid,
		Cols:    opts.Cols,
		Rows:    opts.Rows,
		Started: time.Now().UTC().Format(time.RFC3339),
	})

	// Pump all PTY output to subscribers as data events.
	go pumpPTY(master, sess)

	go func() {
		err := cmd.Wait()
		exit := 0
		errStr := ""
		if err != nil {
			errStr = err.Error()
			if ee, ok := err.(*exec.ExitError); ok {
				if ws, ok := ee.ProcessState.Sys().(syscall.WaitStatus); ok {
					exit = ws.ExitStatus()
				} else {
					exit = 1
				}
			}
		}
		sess.emit(Event{Type: "exit", Exit: exit, Error: errStr, Ended: time.Now().UTC().Format(time.RFC3339)})
		m.remove(sess.ID)
		sess.Close()
	}()

	m.add(sess)
	return sess, nil
}

// pumpPTY reads the master end of the PTY and emits data events. With a
// PTY there is a single combined stream (stdout+stderr are merged by the
// kernel), so we label everything as "stdout".
func pumpPTY(master io.Reader, s *Session) {
	buf := make([]byte, 4096)
	for {
		n, err := master.Read(buf)
		if n > 0 {
			s.emit(Event{Type: "data", Stream: "stdout", Data: string(buf[:n])})
		}
		if err != nil {
			return
		}
	}
}

func (s *Session) Emit(ev Event) { s.emit(ev) }

func (s *Session) emit(ev Event) {
	b, _ := json.Marshal(ev)
	s.listenerMu.Lock()
	// Keep the last ~8KB of output around for late-joining subscribers.
	if ev.Type == "data" {
		s.history = append(s.history, mustUnmarshal(b))
		// Cap retained history to avoid unbounded growth.
		total := 0
		for i := len(s.history) - 1; i >= 0; i-- {
			total += len(s.history[i].Data)
			if total > 8192 {
				s.history = s.history[i+1:]
				break
			}
		}
	}
	for _, ch := range s.listeners {
		select {
		case ch <- mustUnmarshal(b):
		default:
		}
	}
	s.listenerMu.Unlock()
}

func mustUnmarshal(b []byte) Event {
	var e Event
	_ = json.Unmarshal(b, &e)
	return e
}

func (s *Session) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 128)
	s.listenerMu.Lock()
	// Replay buffered output first so a late joiner sees the prompt.
	for _, ev := range s.history {
		select {
		case ch <- ev:
		default:
		}
	}
	s.listeners = append(s.listeners, ch)
	s.listenerMu.Unlock()
	return ch, func() {
		s.listenerMu.Lock()
		defer s.listenerMu.Unlock()
		for i, l := range s.listeners {
			if l == ch {
				s.listeners = append(s.listeners[:i], s.listeners[i+1:]...)
				break
			}
		}
		close(ch)
	}
}

func (s *Session) Write(p []byte) error {
	if s.closed.Load() {
		return errors.New("session closed")
	}
	if s.master == nil {
		return errors.New("session has no pty")
	}
	_, err := s.master.Write(p)
	return err
}

func (s *Session) Resize(rows, cols int) {
	if rows > 0 {
		s.rows = rows
	}
	if cols > 0 {
		s.cols = cols
	}
	if s.master != nil {
		_ = setWinSize(s.master, s.rows, s.cols)
	}
}

func (s *Session) Close() {
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		if s.Cmd != nil && s.Cmd.Process != nil {
			_ = s.Cmd.Process.Kill()
		}
		if s.master != nil {
			_ = s.master.Close()
		}
		if s.cancel != nil {
			s.cancel()
		}
	})
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var buf [20]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
