package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"kscode/internal/shell"
	"kscode/internal/ws"
)

type ShellHandler struct {
	mgr   *shell.Manager
	cwdFn func() string
}

func NewShellHandler(mgr *shell.Manager, cwdFn func() string) *ShellHandler {
	return &ShellHandler{mgr: mgr, cwdFn: cwdFn}
}

func (h *ShellHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/shell/start", h.handleStart)
	mux.HandleFunc("/api/shell/ws", h.handleWS)
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *ShellHandler) handleStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		Cols  int    `json:"cols"`
		Rows  int    `json:"rows"`
		Cwd   string `json:"cwd"`
		Shell string `json:"shell"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	id := newID()
	cwd := req.Cwd
	if cwd == "" {
		cwd = h.cwdFn()
	}
	sess, err := h.mgr.Start(id, shell.StartOptions{
		Cwd:   cwd,
		Cols:  req.Cols,
		Rows:  req.Rows,
		Shell: req.Shell,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":      sess.ID,
		"pid":     sess.Cmd.Process.Pid,
		"cwd":     cwd,
	})
}

type clientMsg struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

func (h *ShellHandler) handleWS(w http.ResponseWriter, r *http.Request) {
	// Browsers send the upgrade via HTTP headers, not a query param.
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		writeError(w, http.StatusBadRequest, "websocket upgrade required")
		return
	}
	id := r.URL.Query().Get("id")
	sess, ok := h.mgr.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	// r.Header.Get already strips the "Sec-WebSocket-Key: " prefix and returns
	// only the raw value, so pass it straight into the SHA-1 handshake.
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		key = "dGhlIHNhbXBsZSBub25jZQ=="
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		writeError(w, http.StatusInternalServerError, "websocket not supported")
		return
	}
	raw, _, err := hj.Hijack()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	conn, err := ws.Upgrade(raw, key)
	if err != nil {
		raw.Close()
		return
	}
	defer conn.Close()

	events, unsub := sess.Subscribe()
	defer unsub()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			frame, err := conn.ReadFrame()
			if err != nil {
				return
			}
			switch frame.Op {
			case ws.OpcodeText:
				var msg clientMsg
				if err := json.Unmarshal(frame.Payload, &msg); err != nil {
					continue
				}
				switch msg.Type {
				case "input":
					_ = sess.Write([]byte(msg.Data))
				case "resize":
					sess.Resize(msg.Rows, msg.Cols)
				case "ping":
					_ = conn.Write(ws.OpcodeText, []byte(`{"type":"pong"}`))
				}
			case ws.OpcodeClose:
				return
			}
		}
	}()

	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return
			}
			b, _ := json.Marshal(ev)
			if err := conn.Write(ws.OpcodeText, b); err != nil {
				return
			}
			if ev.Type == "exit" {
				return
			}
		case <-done:
			return
		}
	}
}
