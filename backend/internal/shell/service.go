package shell

import (
	"bufio"
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
	Stdin      io.WriteCloser
	rows       int
	cols       int
	cwd        string
	cancel     context.CancelFunc
	closed     atomic.Bool
	closeOnce  sync.Once
	listeners  []chan Event
	listenerMu sync.RWMutex
	env        []string
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
	if opts.Cols > 0 {
		cmd.Env = append(cmd.Env, "COLUMNS="+itoa(opts.Cols))
	}
	if opts.Rows > 0 {
		cmd.Env = append(cmd.Env, "LINES="+itoa(opts.Rows))
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}

	sess := &Session{
		ID:     id,
		Cmd:    cmd,
		Stdin:  stdin,
		rows:   opts.Rows,
		cols:   opts.Cols,
		cwd:    cmd.Dir,
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

	go pump(stdout, sess, "stdout")
	go pump(stderr, sess, "stderr")

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

func pump(r io.Reader, s *Session, stream string) {
	br := bufio.NewReaderSize(r, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			s.emit(Event{Type: "data", Stream: stream, Data: string(buf[:n])})
		}
		if err != nil {
			if err != io.EOF {
				return
			}
			return
		}
	}
}

func (s *Session) Emit(ev Event) { s.emit(ev) }

func (s *Session) emit(ev Event) {
	b, _ := json.Marshal(ev)
	s.listenerMu.RLock()
	defer s.listenerMu.RUnlock()
	for _, ch := range s.listeners {
		select {
		case ch <- mustUnmarshal(b):
		default:
		}
	}
}

func mustUnmarshal(b []byte) Event {
	var e Event
	_ = json.Unmarshal(b, &e)
	return e
}

func (s *Session) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 128)
	s.listenerMu.Lock()
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
	_, err := s.Stdin.Write(p)
	return err
}

func (s *Session) Resize(rows, cols int) {
	if rows > 0 {
		s.rows = rows
	}
	if cols > 0 {
		s.cols = cols
	}
	if s.Cmd != nil && s.Cmd.Process != nil {
		_ = syscall.Kill(s.Cmd.Process.Pid, syscall.SIGWINCH)
	}
}

func (s *Session) Close() {
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		if s.Cmd != nil && s.Cmd.Process != nil {
			_ = s.Cmd.Process.Kill()
		}
		if s.Stdin != nil {
			_ = s.Stdin.Close()
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
