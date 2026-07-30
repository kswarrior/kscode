# KS Code

A lightweight, self-hosted AI coding workspace. Think of it as a tiny VS Code in
the browser, backed by a single Go binary: a file explorer, the Monaco code
editor, an embedded terminal (real shell via a WebSocket), and a settings panel
that stores API keys for external LLM providers (Google Gemini, NVIDIA NIM,
OpenAI, Anthropic, ...).

## What's inside

```
ks-code/
+- backend/     Go HTTP server (stdlib only) + file/shell/LLM APIs
+- frontend/    TypeScript + React + Vite (Monaco + Xterm.js)
+- workspace/   default on-disk workspace the server edits
+- codebase.md  full map of every file and the runtime flows
```

## Quick start

### 1. Build the frontend

```bash
cd frontend
npm install
npm run build      # outputs dist/
```

(Dev mode: `npm run dev` then open http://localhost:5173 - Vite proxies
`/api` to the Go server on :8080.)

### 2. Build & run the backend

```bash
cd backend
go build -buildvcs=false -o kscode ./cmd/server
./kscode
```

The server listens on `:8080`, serves the API under `/api/*` and the built
React app from `frontend/dist` at `/`. Open http://localhost:8080.

### Configuration (env vars)

| Variable          | Default                            | Meaning                          |
|-------------------|------------------------------------|----------------------------------|
| `KS_ADDR`         | `:8080`                            | listen address                   |
| `KS_WORKSPACE`    | `/test/ks-code/workspace`          | workspace root edited in browser |
| `KS_API_DIR`      | `/test/ks-code/backend/data`       | where config.json/settings.json live |
| `KS_STATIC`       | `/test/ks-code/frontend/dist`      | directory served at `/`          |
| `KS_FRONTEND_ORIGIN` | `http://localhost:5173`         | allowed CORS origin (dev)        |

API keys are stored encrypted-at-rest-by-permission (chmod 600) in
`$KS_API_DIR/settings.json`. Set them in the Settings panel in the UI.

## Features

- File tree with create folder / create file / rename / delete
- Monaco editor with Ctrl+S save, dirty tracking, per-extension language
- Real shell terminal (bash/sh) over WebSocket with pty-style resize
- Workspace-wide content search with line numbers
- AI chat that forwards to Gemini native API or any OpenAI-compatible endpoint
- Settings persistence (theme, font size, tab size, word wrap, minimap, AI keys)

See `codebase.md` for the complete file map and runtime flows.
