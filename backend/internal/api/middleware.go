package api

import (
	"bufio"
	"log"
	"net"
	"net/http"
	"runtime/debug"
	"time"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
	start  time.Time
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Pass Hijacker through so websocket upgrades still work under the Logger middleware.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// Pass Flusher through so SSE streaming endpoints ( /api/llm/stream,
// /api/agent/run ) keep working under the Logger middleware. Without this
// forwarding, the w.(http.Flusher) assertion in those handlers fails and
// every streaming request returns "streaming not supported".
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Logger emits one structured log line per request.
func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, start: time.Now()}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s -> %d %dB %s",
			r.Method, r.URL.Path, rec.status, rec.bytes, time.Since(rec.start))
	})
}

// Recoverer converts panics into 500 JSON responses.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic in %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
				writeError(w, http.StatusInternalServerError, "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// CORSMiddleware adds CORS headers (the API is meant for local tooling).
func CORSMiddleware(allowed map[string]bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed[origin] || allowed["*"] {
			if origin == "" && allowed["*"] {
				origin = "*"
			}
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Chain applies middlewares in order.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}
