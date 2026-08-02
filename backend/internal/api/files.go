package api

import (
	"net/http"

	"kscode/internal/fs"
)

type FilesHandler struct {
	svc    *fs.Service
	rootFn func() string // optional: when set, resolves a fresh service per request
}

func NewFilesHandler(svc *fs.Service) *FilesHandler {
	return &FilesHandler{svc: svc}
}

// NewFilesHandlerFromRoot builds a handler whose filesystem root is resolved
// lazily per request via rootFn. Used so opening a project switches the FS
// root without restarting the process.
func NewFilesHandlerFromRoot(rootFn func() string) *FilesHandler {
	return &FilesHandler{rootFn: rootFn}
}

// svcFor returns an fs.Service for this request. When rootFn is configured we
// rebuild it for the current active root; otherwise we use the static svc.
func (h *FilesHandler) svcFor() (*fs.Service, error) {
	if h.rootFn == nil {
		return h.svc, nil
	}
	return fs.NewService(h.rootFn())
}

func (h *FilesHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/files/tree", h.handleTree)
	mux.HandleFunc("/api/files/read", h.handleRead)
	mux.HandleFunc("/api/files/write", h.handleWrite)
	mux.HandleFunc("/api/files/mkdir", h.handleMkdir)
	mux.HandleFunc("/api/files/delete", h.handleDelete)
	mux.HandleFunc("/api/files/rename", h.handleRename)
	mux.HandleFunc("/api/files/search", h.handleSearch)
}

func (h *FilesHandler) handleTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	p := r.URL.Query().Get("path")
	depth := 8
	if d := r.URL.Query().Get("depth"); d != "" {
		var v int
		_, _ = jsonAtoi(d, &v)
		depth = v
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	tree, err := svc.Tree(p, depth)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"root":  svc.Root(),
		"entry": tree,
	})
}

func (h *FilesHandler) handleRead(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	fc, err := svc.Read(p)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fc)
}

func (h *FilesHandler) handleWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req fs.WriteRequest
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "path required")
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	fc, err := svc.Write(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fc)
}

func (h *FilesHandler) handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	e, err := svc.Mkdir(req.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (h *FilesHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		methodNotAllowed(w, http.MethodPost, http.MethodDelete)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := svc.Delete(req.Path); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *FilesHandler) handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	e, err := svc.Rename(req.OldPath, req.NewPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (h *FilesHandler) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		writeError(w, http.StatusBadRequest, "q required")
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	res, err := svc.Search(q, 200)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func jsonAtoi(s string, out *int) (int, error) {
	v := 0
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0, nil
		}
		v = v*10 + int(ch-'0')
	}
	*out = v
	return v, nil
}
