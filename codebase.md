# KS Code - Codebase Map & Flows
This document is the authoritative map of every source file in the KS Code
repository together with short notes on what each file does, followed by a
description of the main runtime flows (file editing, shell execution, AI
chat, settings).

## 1. Repository at a glance
```
ks-code/
+- README.md                  project overview + quick start
+- codebase.md                THIS FILE - full map and flows
+- workspace/                 default on-disk workspace (edited by the server)
|
+- backend/                   Go HTTP server (standard library only)
|  +- go.mod                  module kscode, go 1.25
|  +- cmd/server/main.go      entrypoint - wiring + graceful shutdown
|  +- internal/
|     +- config/config.go     runtime config (env vars) + JSON store
|     +- fs/service.go        file system operations service
|     +- shell/service.go     persistent shell session manager
|     +- settings/service.go  user settings + AI provider key store
|     +- llm/client.go        LLM client (Gemini native + OpenAI-compat)
|     +- ws/conn.go           minimal RFC6455 WebSocket server (no deps)
|     +- api/                 HTTP handlers and middleware
|        +- router.go         builds the ServeMux with all handlers
|        +- middleware.go     CORS, logging, panic-recovery
|        +- util.go           writeJSON / writeError / parseJSON helpers
|        +- workspace.go      GET /api/health, GET /api/workspace
|        +- files.go          file CRUD + search endpoints
|        +- shell.go          POST /api/shell/start, WS /api/shell/ws
|        +- settings.go       GET/POST /api/settings, provider upsert/delete
|        +- llm.go            POST /api/llm/chat
|
+- frontend/                 TypeScript + React + Vite SPA
|  +- package.json           deps: React, @monaco-editor/react, @xterm/*
|  +- tsconfig.json          strict TS config (bundler resolution)
|  +- tsconfig.node.json     TS config for vite.config.ts
|  +- vite.config.ts         dev server on :5173, proxy /api -> :8080
|  +- index.html             SPA shell
|  +- dist/                  vite build output (served by Go in prod)
|  +- src/
|     +- main.tsx            React root mount
|     +- App.tsx             top-level -> WorkspaceLayout
|     +- vite-env.d.ts        vite client types
|     +- styles/global.css   resets + scrollbar styling
|     +- types/index.ts      shared TS interfaces (FileEntry, Settings, ...)
|     +- api/client.ts       typed fetch wrapper for every backend endpoint
|     +- hooks/
|     |  +- useWorkspace.ts  loads + refreshes the file tree
|     |  +- useSettings.ts   loads + saves settings / provider keys
|     +- components/
|        +- Layout/WorkspaceLayout.tsx(.css)   3-panel app shell
|        +- FileTree/FileTree.tsx(.css)       recursive explorer + actions
|        +- Editor/Editor.tsx(.css)           Monaco wrapper + Ctrl+S
|        +- Terminal/Terminal.tsx(.css)       Xterm.js + WS bridge
|        +- Settings/Settings.tsx(.css)        editor + AI provider config
|        +- Chat/ChatPanel.tsx(.css)          AI chat prompt/response UI
|        +- Search/SearchPanel.tsx(.css)      workspace content search
```

## 2. Backend file notes

### backend/go.mod
- Module name `kscode`, Go 1.25.
- Zero external dependencies; uses only the Go standard library
  (incl. a hand-written WebSocket implementation in `internal/ws`).

### backend/cmd/server/main.go - entrypoint
- Builds the config store, settings store, fs service, shell manager and LLM client
- Constructs every API handler and wires them into one `http.ServeMux` via `api.New`
- Mounts `/api/` on the API mux and `/` on an SPA handler that serves
  `frontend/dist` with a fallback to index.html for client routing
- Wraps the root handler in CORS -> Recoverer -> Logger middleware
- Listens on `cfg.Addr` and performs graceful shutdown on SIGINT/SIGTERM
- `spaHandler` serves a static file if present else falls back to index.html

### backend/internal/config/config.go - configuration
- `Config` holds addr, workspace dir, static dir, api data dir, CORS origins, env
- `Default()` reads values from env vars (KS_ADDR, KS_WORKSPACE, ...) with sane fallbacks
- `EnsureDirs()` makes sure the workspace and api-data directories exist
- `Store` is a thread-safe JSON-backed persistence layer for the config file;
  `Get()` returns a deep copy, `Update(fn)` mutates under a write lock

### backend/internal/fs/service.go - file system operations
- Sandboxed at `root`: every path is resolved and verified to stay inside the root
  (`resolve` rejects `..` escapes) so the API cannot touch arbitrary disk paths
- `Tree(path, depth)` builds a recursive `Entry` tree (dirs first, hidden files skipped)
- `Read` returns content + detected language for the Monaco editor
- `Write` creates parent dirs and writes a file (MkdirAll + WriteFile)
- `Mkdir`, `Delete` (refuses to remove the root), `Rename` (with re-expanded children)
- `Search(query, max)` walks the tree skipping .git/node_modules/dist and returns
  `{path, line, preview}` matches; skips files > 2 MB
- `detectLanguage` maps extensions (go/ts/js/json/yaml/...) to Monaco language ids

### backend/internal/shell/service.go - shell sessions
- `Manager` keeps a map of `*Session` keyed by random hex id
- `Start(id, opts)` spawns `$SHELL` (default /bin/bash) with a pty-style
  stdin/stdout/stderr and emits a `start` event carrying the PID
- Two pumps read stdout/stderr line-buffered and emit `data` events tagging
  the stream (`stdout`/`stderr`); stderr events keep the xterm red coloring intact
- On process exit a goroutine emits an `exit` event with the status code and removes
  the session; `cancel()` kills the process if the client disconnects
- `Resize(rows, cols)` records the new size and sends SIGWINCH so line editors (readline)
  re-flow.
- `Subscribe()` returns a channel + unsubscribe func; used by the websocket handler
- `Write`/`Close` are guarded against closed sessions (atomic flag + sync.Once)

### backend/internal/settings/service.go - settings + API keys
- `Settings` = `{AI: {defaultProvider, providers[]}, UI: {theme, fontSize, tabSize, wordWrap, minimap}}`
- `Default()` seeds four providers: Gemini, NVIDIA NIM, OpenAI, Anthropic with their
  canonical base URLs (keys empty, enabled=false)
- `Store` persists to `$KS_API_DIR/settings.json` with mode 0600 (only owner can read)
- `Save` validates provider ids; `UpsertProvider`/`DeleteProvider` mutate by id
- `KeyFor(id)` is the lookup the LLM client uses to fetch a key at call time
  (keys never leave the server to the browser except through the settings GET,
  which is acceptable for a local single-user tool)

### backend/internal/llm/client.go - LLM forwarding
- `Client` wraps `*settings.Store` + a 90s `http.Client`
- `Chat(ctx, req)` looks up the provider + key, then dispatches:
  - `gemini` -> native Gemini `generateContent` (`?key=...`)
  - `nvidia`/`openai`/`anthropic`/... -> OpenAI-compatible `/chat/completions`
- Returns `{provider, model, content, raw}` or an error describing the upstream status.
- Default models are chosen per provider if the request omits one.

### backend/internal/ws/conn.go - WebSocket server
- Self-contained RFC6455 server (no gorilla/websocket).
- `Upgrade(raw, key)` does the `101 Switching Protocols` handshake using the
  SHA-1 + base64 of `Sec-WebSocket-Key` + the RFC magic GUID.
- `ReadFrame` handles 7/16/64-bit lengths and client-side masking, returning the
  unmasked payload. `Write(op, data)` sends a server (unmasked) frame.
- Used only by the websocket fd (`/api/shell/ws`). The HTTP layers use stdlib.

### backend/internal/api/router.go
- `Server` wraps a single `http.ServeMux`.
- `New(fsH, shellH, settingsH, llmH, workspaceH)` instantiates the mux and calls
  `Register(mux)` on each handler. Handler returns `Handler()`.

### backend/internal/api/middleware.go
- `statusRecorder` captures the status code + body size for logging.
- `Logger` logs `METHOD path -> status bytes duration`.
- `Recoverer` turns panics into a 500 JSON `{error: 'internal server error'}`.
- `CORSMiddleware(allowed map[string]bool, next)` reflects the request Origin
  when it is in the allow-list (or '*' if the list is empty) and short-circuits
  preflight OPTIONS with 204.
- `Chain` composes middlewares outside-in.

### backend/internal/api/util.go
- `writeJSON` / `writeError` / `parseJSON` - small helpers used by every handler.
`parseJSON` uses `DisallowUnknownFields` for stricter input validation.

### backend/internal/api/workspace.go
- `GET /api/health` -> `{status, time, uptime}`.
- `GET /api/workspace` -> `{root, apiDir, staticDir}` so the UI can display the
  configured workspace root.

### backend/internal/api/files.go
- `GET /api/files/tree?path=&depth=` -> `{root, entry}` (recursive tree).
- `GET /api/files/read?path=` -> the file content + language.
- `POST /api/files/write` body `{path, content}` -> writes a file.
- `POST /api/files/mkdir` body `{path}`.
- `POST /api/files/delete` body `{path}` (also accepts DELETE).
- `POST /api/files/rename` body `{oldPath, newPath}`.
- `GET /api/files/search?q=` -> `{results: [{path, line, preview}]}`.

### backend/internal/api/shell.go
- `POST /api/shell/start` body `{cols, rows, cwd?, shell?}` -> `{id, pid, cwd}`.
  A new session id is minted; the manager spawns the shell.
- `GET /api/shell/ws?id=` upgrades to a WebSocket and bridges:
  - inbound JSON `{type:'input', data}` -> `Session.Write`
  - inbound JSON `{type:'resize', rows, cols}` -> `Session.Resize`
  - inbound JSON `{type:'ping'}` -> pong
  - outbound session events -> JSON frames
  The loop exits on `exit` events or socket close; the session is removed
  from the manager on process exit.

### backend/internal/api/settings.go
- `GET /api/settings` returns the full settings object.
- `POST /api/settings` replaces it (validated).
- `POST /api/settings/providers` upserts a single provider (used by the
  'Save Key' button so a key can be stored without rewriting the whole object).
- `POST /api/settings/providers/delete` body `{id}`.

### backend/internal/api/llm.go
- `POST /api/llm/chat` body `{provider, model, messages, maxTokens?}`.
  Forwards to the `llm.Client`, returns `{provider, model, content, raw?}`.
  Errors (missing key, upstream 4xx/5xx) are returned as a 502 JSON.

## 3. Frontend file notes

### frontend/package.json
- `type: module`, scripts: dev/build/preview/typecheck.
- Runtime deps: `react`, `react-dom`, `@monaco-editor/react`, `@xterm/xterm`, `@xterm/addon-fit`.
- Dev deps: `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react(-dom)`.

### frontend/tsconfig.json + tsconfig.node.json
- Strict TS targeting ES2022 with bundler module resolution and `react-jsx`.
- `skipLibCheck` + `resolveJsonModule`; no project references (single root).
### frontend/vite.config.ts
- React plugin, output to `dist` (emptyOutDir).
- Dev server on :5173 with a proxy mapping `/api` -> http://localhost:8080
  (with ws:true so the shell WebSocket is forwarded too).

### frontend/index.html
- Minimal SPA shell: `#root` div + module script `/src/main.tsx`.

### frontend/src/main.tsx
- Creates the React root on `#root` and renders `<App/>` in StrictMode.
- Imports `./styles/global.css`.

### frontend/src/App.tsx
- Default-exports `<WorkspaceLayout/>` - the whole app composition root.

### frontend/src/types/index.ts
- All shared interfaces mirroring the backend JSON shapes: `FileEntry`,
  `FileContent`, `SearchResult`, `Provider`, `AISettings`, `UISettings`,
  `Settings`, `ShellEvent`, `ShellStartResponse`, `ChatRequest`, `ChatResponse`.

### frontend/src/api/client.ts
- `req<T>(path, init)` helper: fetch `${BASE}${path}` with JSON content-type,
  parses text, falls back to raw text, throws `Error(body.error|HTTP n)`.
- `api` object groups every endpoint (health, files.{tree,read,write,mkdir,
  remove,rename,search}, settings.{get,save,upsertProvider,deleteProvider},
  shell.{start, wsUrl}, llm.chat). `shell.wsUrl` builds the WS URL from
  `window.location` so it works in both dev (proxy) and prod (same-origin).

### frontend/src/hooks/useWorkspace.ts
- `useState` for root + tree + loading + error.
- `refresh(path)` calls `api.files.tree`. Auto-runs on mount.
- Returned as `{root, tree, loading, error, refresh}` for the FileTree.

### frontend/src/hooks/useSettings.ts
- Loads settings once via `api.settings.get`.
- Exposes `save(settings)`, `upsertProvider(p)`, `deleteProvider(id)`
  that each update local state from the server response.

### frontend/src/components/Layout/WorkspaceLayout.tsx(.css)
- The 3-region shell: top header (brand + nav buttons), left sidebar
  (Files/Search tabs), center editor + terminal split, and overlays for
  Settings and Chat (absolutely positioned right drawers).
- Local UI state: active file path, sidebar/terminal open booleans, which
  sidebar tab. Wires `useWorkspace` + `useSettings`.
- `Reload` re-fetches both the tree and settings.

### frontend/src/components/FileTree/FileTree.tsx(.css)
- Recursive `TreeNode` renders icon + name; folders toggle expand, files open.
- Row hover reveals action buttons: new folder (+), new file (+f), rename (E), delete (x).
- Inline rename uses a focused input; Enter commits, Escape cancels.
- New folder / new file use the parent path; all mutations call `api.files.*`
  then `onRefresh()` to reload the tree.

### frontend/src/components/Editor/Editor.tsx(.css)
- Wraps `@monaco-editor/react` `<Editor>` controlled by the current `filePath`.
- On path change, loads content via `api.files.read`, tracks `dirty` by
  diffing against the saved snapshot in `onDidChangeModelContent`.
- Saves via `api.files.write` on Ctrl/Cmd+S (both a Monaco command and a
  global window keydown handler); the toolbar also has a Save button.
- Editor options (theme, fontSize, tabSize, wordWrap, minimap) come from settings.

### frontend/src/components/Terminal/Terminal.tsx(.css)
- Creates an Xterm.js `Terminal` with the FitAddon on mount; disposes on unmount.
- `Start` calls `api.shell.start({cols, rows, cwd})`, opens a WebSocket to
  `api.shell.wsUrl(id)`, and bridges:
  - `term.onData` -> WS `{type:'input', data}`
  - WS `data` (stderr) -> red-colored `term.write`; (stdout) -> plain write
  - WS `exit` -> colored exit banner, status -> exited
- Window resize triggers `fit.fit()` + a WS `resize` message.
- Stop closes the socket and disposes the onData handle.

### frontend/src/components/Search/SearchPanel.tsx(.css)
- Text input + Search button; calls `api.files.search(q)`.
- Lists results; clicking a result opens the file in the editor (`onOpen(path)`)
  and switches the sidebar back to the Files tab.

### frontend/src/components/Settings/Settings.tsx(.css)
- Drawer over the right side. Editor section: theme, font size, tab size,
  word wrap, minimap. AI section: default provider + one row per provider.
- Each `ProviderRow` has base URL + API key (password input with show/hide),
  an enabled checkbox and a 'Save Key' button that calls `upsertProvider`
  immediately (persists just that key without committing other unsaved UI changes).
- A 'Save Settings' button at the bottom commits the whole draft (UI + default + keys).
- Keys are stored server-side at `$KS_API_DIR/settings.json` (chmod 600).

### frontend/src/components/Chat/ChatPanel.tsx(.css)
- Right drawer. Provider + model selectors (model list per provider).
- Message log with role-colored left borders; user/assistant turns are
  appended locally. Send posts `api.llm.chat` and appends the model reply.
- Ctrl/Cmd+Enter sends. Errors surface both inline and as an assistant turn.

### frontend/src/styles/global.css
- CSS reset, full-height html/body/#root, dark background, custom scrollbars.

## 4. Runtime flows

### Flow A - Open and edit a file
1. App mount -> `useWorkspace` calls `api.files.tree('/')` -> FileTree renders.
2. User clicks a file node -> `onOpen(path)` sets `activePath` in WorkspaceLayout.
3. `<CodeEditor filePath=...>` effect fires `api.files.read(path)` -> Monaco loads content.
4. User types -> `onDidChangeModelContent` sets `dirty=true` (compares to savedContent).
5. User presses Ctrl+S -> `api.files.write(path, content)` -> state cleared, dirty=false.
6. If the file is new it is created under the workspace root automatically.

### Flow B - Run a shell command
1. TerminalPanel mounts Xterm (FitAddon). Status 'idle'.
2. User clicks Start -> `api.shell.start({cols, rows, cwd})` -> backend spawns $SHELL.
3. Backend returns {id, pid, cwd}; UI opens WS to /api/shell/ws?id=...
4. UI -> WS: {type:'input', data:'ls -la
'}
5. Shell session writes stdin to the process; stdout/stderr pumps emit 'data' events.
6. Backend -> WS: {type:'data', stream:'stdout', data:'total 4\n...'} (stderr is red-tagged).
7. term.write renders the bytes; FitAddon keeps the grid sized to the container.
8. Window resize -> WS {type:'resize', rows, cols} -> backend SIGWINCH -> readline reflows.
9. When the shell exits, {type:'exit', exit:0} is sent and the WS closes the session.

### Flow C - AI chat
1. User opens Chat drawer, picks provider + model, types a prompt.
2. UI calls `api.llm.chat({provider, model, messages})`.
3. Backend `llm.Client.Chat`:
   - reads the API key for the provider from settings.Store (KeyFor)
   - if missing -> returns 502 'provider api key not configured'
   - gemini -> POST {base}/models/{model}:generateContent?key={apiKey}
   - others  -> POST {base}/chat/completions  with Authorization: Bearer {apiKey}
4. Response content is parsed and `{provider, model, content, raw}` returned to the UI.
5. UI appends an assistant turn (or an error turn) to the message list.

### Flow D - Settings & API keys
1. `useSettings` GETs /api/settings on mount (seeds defaults if no file exists).
2. User edits UI prefs / enables providers / pastes keys in the Settings drawer.
3. 'Save Settings' POSTs the whole object -> backend validates, rewrites settings.json (0600).
4. 'Save Key' on a single row POSTs /api/settings/providers with that provider
   (persists immediately so a key can be used without committing UI changes).
5. Keys are read server-side only; the chat flow fetches the key via settings.Store
   just before sending the upstream request.

### Flow E - Workspace search
1. User switches the sidebar to Search, types a query, presses Enter.
2. UI calls `api.files.search?q=...`; the FS service walks the workspace root
   skipping .git/node_modules/dist and files > 2 MB, scanning line by line.
3. Results {path, line, preview} are listed; clicking opens the file in the editor.

## 5. Build & run (cheat sheet)
```bash
# Frontend
cd frontend && npm install && npm run build      # -> dist/

# Backend
cd backend && go build -buildvcs=false -o kscode ./cmd/server
./kscode                                          # http://localhost:8080

# Dev (two terminals)
cd backend && go run -buildvcs=false ./cmd/server  # :8080
cd frontend && npm run dev                        # :5173 (proxies /api -> :8080)
```

## 6. Notable design choices
- **Zero external Go deps**: net/http + a hand-written RFC6455 WebSocket (ws/conn.go)
  keep `go build` self-contained and hermetic.
- **Path sandboxing**: the FS service rejects any resolved path that escapes the
  workspace root, so the API cannot read/write arbitrary disk locations.
- **Real pty-style shell**: stdin/stdout/stderr + SIGWINCH give a faithful
  interactive terminal (readline, ANSI color, resize all behave).
- **Keys never hard-coded**: stored in settings.json (0600) and fetched at call time;
  the user can rotate keys without touching source.
- **Single binary deploy**: in production the Go process serves the React bundle
  from `frontend/dist`, so the whole app is one executable + one workspace dir.
