import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client";
import type { ShellEvent, ShellStartResponse } from "../../types";
import "./Terminal.css";

// hardClear wipes the xterm viewport + scrollback and repositions the cursor
// at the top-left, mimicking what a real VT does on `clear` / Ctrl-L when the
// shell's own redraw is also nuked. We keep the buffer's current cell modes.
function hardClear(term: import("@xterm/xterm").Terminal | null) {
  if (!term) return;
  // term.clear() drops the scrollback and pulls the current viewport to the
  // top — closest to a real "clear".
  try { (term as any).clear(); } catch { /* noop */ }
  // Additionally send a hard-reset of the visible region so any leftover
  // full-screen alternate buffer (e.g. a vim session that exited) is gone.
  try {
    // ESC[H  -> cursor home; ESC[2J -> erase entire display; ESC[3J -> erase
    // scrollback (xterm extension; safe to ignore on parsers that don't know it).
    term.write("\x1b[H\x1b[2J\x1b[3J");
  } catch { /* noop */ }
}

interface Props {
  cwd: string;
  fontSize?: number;
  /** When provided, the terminal connects to this existing session instead of starting a new one. */
  sessionId?: string | null;
  /** When true, immediately opens the session on mount (used for reconnecting to existing sessions). */
  autoStart?: boolean;
  /** Called when the session exits or is closed. */
  onExit?: () => void;
  /** Called to register the clear function for external use. */
  onRegisterClear?: (fn: (() => void) | null) => void;
}

export function TerminalPanel({ cwd, fontSize = 14, sessionId, autoStart, onExit, onRegisterClear }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [activeId, setActiveId] = useState<string | null>(null);

  // Keep a ref to the latest status so ws.onclose sees the freshest value.
  const statusRef = useRef<string>("idle");
  useEffect(() => { statusRef.current = status; }, [status]);

  // Create the xterm instance once.
  useEffect(() => {
    const term = new XTerm({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      convertEol: true,
      // Allow ANSI 256-color sequences from full-screen TUIs (vim, top, tmux,
      // clear, less) to render correctly and let programs that need the
      // application cursor / keypad modes work.
      allowProposedApi: true,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    try { fit.fit(); } catch { /* noop */ }
    termRef.current = term;
    fitRef.current = fit;
    term.writeln("\x1b[36mKS Code Terminal\x1b[0m");

    // Custom key handling so the terminal behaves like a real VT: Ctrl+letter
    // combos go to the shell as control characters (Ctrl-C = \x03, Ctrl-L =
    // \x0c clears the screen, Ctrl-D = \x04 EOF, Ctrl-Z = \x1a suspend, ...),
    // while a few Ctrl+Shift combos stay local (copy/paste/clear). Returning
    // false cancels the default so xterm doesn't double-handle; returning true
    // lets xterm forward the keystroke as data (and the browser keeps doing
    // nothing because we already preventDefault at the window level for most).
    term.attachCustomKeyEventHandler((e) => {
      // We only care about keydown; let keypress/keyup pass.
      if (e.type !== "keydown") return true;

      const ctrl = e.ctrlKey;
      const meta = e.metaKey;
      const shift = e.shiftKey;
      const mod = ctrl || meta;

      // Ctrl+Shift+C = copy selection (like gnome-terminal / xterm). If there
      // is a selection, copy it and swallow the key; otherwise let Ctrl-C
      // through to the shell as a SIGINT.
      if (mod && shift && (e.key === "C" || e.key === "c")) {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard?.writeText(sel).catch(() => { /* noop */ });
          term.clearSelection();
          return false; // don't send \x03
        }
        return false; // even without a selection, swallow so it never SIGINTs
      }
      // Ctrl+Shift+V = paste from clipboard into the PTY.
      if (mod && shift && (e.key === "V" || e.key === "v")) {
        navigator.clipboard?.readText().then((text) => {
          if (text && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "input", data: text }));
          }
        }).catch(() => { /* noop */ });
        return false;
      }
      // Ctrl+Shift+L (or Cmd+K on mac) = clear the screen + scrollback, then
      // make the shell reprint its prompt by sending a Ctrl-L (\x0c).
      if ((mod && shift && (e.key === "L" || e.key === "l")) ||
          (meta && !ctrl && (e.key === "k" || e.key === "K"))) {
        hardClear(term);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data: "\x0c" }));
        }
        return false;
      }

      // Plain Ctrl+letter combos the shell handles: pass through to the PTY.
      // xterm already does this by default for most, but being explicit AND
      // returning true (with preventDefault stopping the browser) guarantees
      // nothing in the app steals them (Ctrl-S save, Ctrl-W close tab, etc.).
      if (ctrl && !shift && !meta && e.key.length === 1) {
        const code = e.key.toUpperCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x5a) {
          // A..Z -> control char \x01..\x1a. xterm's onCustom will forward it
          // through onData; we just need to ensure the browser's default
          // shortcut (Ctrl-S save, Ctrl-R reload, Ctrl-F find, ...) is blocked
          // so the keystroke isn't hijacked before it reaches the shell.
          e.preventDefault();
          return true;
        }
      }

      return true;
    });

    const onResize = () => {
      try {
        fit.fit();
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "resize",
            rows: term.rows,
            cols: term.cols,
          }));
        }
      } catch { /* noop */ }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      stop();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open when reconnecting to an existing session.
  useEffect(() => {
    if (autoStart && sessionId) {
      void openSession(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, autoStart]);

  const wireWS = (ws: WebSocket, term: XTerm) => {
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus("connected");
      term.focus();
      // Sync the local terminal size with the remote PTY.
      try {
        ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
      } catch { /* noop */ }
    };
    ws.onmessage = (ev) => {
      let evt: ShellEvent;
      try { evt = JSON.parse(ev.data); }
      catch { return; }
      if (evt.type === "start" || evt.type === "data") {
        const stream = evt.stream;
        if (evt.data) {
          if (stream === "stderr") {
            term.write("\x1b[31m" + evt.data + "\x1b[0m");
          } else {
            term.write(evt.data);
          }
        }
      } else if (evt.type === "exit") {
        if (evt.exit === 0) {
          term.writeln(`\x1b[32m[process exited ${evt.exit}]\x1b[0m`);
        } else {
          term.writeln(`\x1b[31m[process exited ${evt.exit}: ${evt.error || ""}]\x1b[0m`);
        }
        setStatus("exited");
        onExit?.();
      }
    };
    ws.onerror = () => {
      setStatus("error");
      term.writeln(`\x1b[31m[websocket error]\x1b[0m`);
    };
    ws.onclose = () => {
      if (statusRef.current !== "exited") setStatus("closed");
    };
    const onTermData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    };
    const dataDisposable = term.onData(onTermData);
    (term as any).__cleanup_data = () => { dataDisposable.dispose(); };
  };

  const openSession = async (id: string) => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try { fit.fit(); } catch { /* noop */ }
    setStatus("starting");
    setActiveId(id);
    const ws = new WebSocket(api.shell.wsUrl(id));
    wireWS(ws, term);
  };

  const start = async () => {
    const term = termRef.current!;
    const fit = fitRef.current!;
    try { fit.fit(); } catch { /* noop */ }
    try {
      setStatus("starting");
      const res: ShellStartResponse = await api.shell.start({
        cols: term.cols,
        rows: term.rows,
        cwd,
      });
      setActiveId(res.id);
      const ws = new WebSocket(api.shell.wsUrl(res.id));
      wireWS(ws, term);
    } catch (e: any) {
      setStatus("error");
      term.writeln(`\x1b[31m[failed to start shell: ${e.message}]\x1b[0m`);
    }
  };

  const stop = () => {
    const term = termRef.current;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* noop */ }
      wsRef.current = null;
    }
    if (term && (term as any).__cleanup_data) {
      (term as any).__cleanup_data();
      (term as any).__cleanup_data = null;
    }
    setStatus("closed");
  };

  const clearTerm = () => {
    // A "real" terminal clear: wipe the viewport AND the scrollback so nothing
    // remains scrollable, then redraw a fresh prompt (the shell reprints its
    // prompt when it receives a Form Feed \x0c). term.reset() clears state
    // but resets ANSI modes too, which can desync the shell (e.g. alt-screen
    // toggle) — so we use term.clear() for scrollback and an explicit cursor
    // home + erase-screen sequence instead.
    hardClear(termRef.current);
    // If a shell is connected, send Ctrl-L so bash re-renders the prompt /
    // any full-screen program you're in (vim etc.) repaints. Otherwise just
    // print a spacer.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: "\x0c" }));
    }
  };

  // Register clear function for external use (e.g., from TerminalsPanel)
  useEffect(() => {
    if (onRegisterClear) {
      onRegisterClear(clearTerm);
      return () => onRegisterClear(null);
    }
  }, [onRegisterClear]);

  const statusColor = status === "connected" ? "#4ec9b0"
    : status === "error" || status === "exited" ? "#f48771"
    : "#cccccc";

  return (
    <div className="terminal-panel">
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}
