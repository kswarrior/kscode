package api

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	fsservice "kscode/internal/fs"
)

type FilesHandler struct {
	svc    *fsservice.Service
	rootFn func() string // optional: when set, resolves a fresh service per request
}

func NewFilesHandler(svc *fsservice.Service) *FilesHandler {
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
func (h *FilesHandler) svcFor() (*fsservice.Service, error) {
	if h.rootFn == nil {
		return h.svc, nil
	}
	return fsservice.NewService(h.rootFn())
}

func (h *FilesHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/files/tree", h.handleTree)
	mux.HandleFunc("/api/files/read", h.handleRead)
	mux.HandleFunc("/api/files/write", h.handleWrite)
	mux.HandleFunc("/api/files/mkdir", h.handleMkdir)
	mux.HandleFunc("/api/files/delete", h.handleDelete)
	mux.HandleFunc("/api/files/rename", h.handleRename)
	mux.HandleFunc("/api/files/search", h.handleSearch)
	mux.HandleFunc("/api/files/download", h.handleDownload)
	mux.HandleFunc("/api/files/download-zip", h.handleDownloadZip)
	mux.HandleFunc("/api/files/download-project", h.handleDownloadProject)
	mux.HandleFunc("/api/files/upload", h.handleUpload)
	mux.HandleFunc("/api/files/upload-url", h.handleUploadURL)
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
	var req fsservice.WriteRequest
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

func (h *FilesHandler) handleDownload(w http.ResponseWriter, r *http.Request) {
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
	full, err := svc.Resolve(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if info.IsDir() {
		writeError(w, http.StatusBadRequest, "cannot download a directory, use /download-zip")
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", info.Name()))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	http.ServeFile(w, r, full)
}

func (h *FilesHandler) handleDownloadZip(w http.ResponseWriter, r *http.Request) {
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
	full, err := svc.Resolve(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "path not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "path is not a directory")
		return
	}
	baseName := filepath.Base(full)
	if baseName == "." || baseName == string(filepath.Separator) {
		baseName = "project"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", baseName+".zip"))
	w.Header().Set("Content-Type", "application/zip")
	zw := zip.NewWriter(w)
	defer zw.Close()
	err = filepath.WalkDir(full, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(full, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			_, err = zw.Create(rel + "/")
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name = rel
		hdr.Method = zip.Deflate
		zwr, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		_, err = io.Copy(zwr, f)
		return err
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func (h *FilesHandler) handleDownloadProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	full := svc.Root()
	if _, err := os.Stat(full); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	baseName := filepath.Base(full)
	if baseName == "." || baseName == string(filepath.Separator) {
		baseName = "project"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", baseName+".zip"))
	w.Header().Set("Content-Type", "application/zip")
	zw := zip.NewWriter(w)
	defer zw.Close()
	err = filepath.WalkDir(full, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(full, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			_, err = zw.Create(rel + "/")
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		fi, err := f.Stat()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name = rel
		hdr.Method = zip.Deflate
		zwr, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		_, err = io.Copy(zwr, f)
		return err
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

func (h *FilesHandler) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	err := r.ParseMultipartForm(32 << 20)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file field required")
		return
	}
	defer file.Close()
	targetPath := r.FormValue("path")
	if targetPath == "" {
		targetPath = "/"
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	full, err := svc.Resolve(targetPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		writeError(w, http.StatusBadRequest, "target path not found")
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "target path is not a directory")
		return
	}
	destPath := filepath.Join(full, header.Filename)
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	dst, err := os.Create(destPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "uploaded", "path": svc.Rel(destPath)})
}

func (h *FilesHandler) handleUploadURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	var req struct {
		URL  string `json:"url"`
		Path string `json:"path"`
	}
	if err := parseJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.URL == "" {
		writeError(w, http.StatusBadRequest, "url required")
		return
	}
	if req.Path == "" {
		req.Path = "/"
	}
	svc, err := h.svcFor()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	full, err := svc.Resolve(req.Path)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(full)
	if err != nil {
		writeError(w, http.StatusBadRequest, "target path not found")
		return
	}
	if !info.IsDir() {
		writeError(w, http.StatusBadRequest, "target path is not a directory")
		return
	}
	resp, err := http.Get(req.URL)
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to fetch URL")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("URL returned status %d", resp.StatusCode))
		return
	}
	fileName := filepath.Base(req.URL)
	if fileName == "" || fileName == "." || fileName == "/" {
		fileName = "download"
	}
	destPath := filepath.Join(full, fileName)
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	dst, err := os.Create(destPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, resp.Body); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "uploaded", "path": svc.Rel(destPath)})
}
