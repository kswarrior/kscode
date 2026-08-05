import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client";
import type { ShellEvent, ShellStartResponse } from "../../types";
import { IconErase, IconPlay, IconStop, IconTerminal } from "../Icon";
import "./Terminal.css";

interface Props {
  cwd: string;
  fontSize?: number;
  /** When provided, the terminal connects to this existing session instead of starting a new one. */
  sessionId?: string | null;
  /** When true, immediately opens the session on mount (used for reconnecting to existing sessions). */
  autoStart?: boolean;
  /** Called when the session exits or is closed. */
  onExit?: () => void;
}

export function TerminalPanel({ cwd, fontSize = 14, sessionId, autoStart, onExit }: Props) {
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
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    try { fit.fit(); } catch { /* noop */ }
    termRef.current = term;
    fitRef.current = fit;
    term.writeln("\x1b[36mKS Code Terminal\x1b[0m");

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
    termRef.current?.clear();
  };

  const statusColor = status === "connected" ? "#4ec9b0"
    : status === "error" || status === "exited" ? "#f48771"
    : "#cccccc";

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className="terminal-title row"><IconTerminal size={16} /> TERMINAL</span>
        <span className="terminal-status-pill" style={{ color: statusColor, borderColor: statusColor }}>
          <i className="terminal-dot" style={{ background: statusColor }} />
          {status}{activeId ? ` (${activeId.slice(0, 8)})` : ""}
        </span>
        <div className="terminal-buttons">
          {status !== "connected" && status !== "starting" && (
            <button className="btn btn-primary" onClick={start}><IconPlay size={15} /> <span className="hidden-mobile">Start</span></button>
          )}
          {status === "connected" && (
            <button className="btn" onClick={stop}><IconStop size={15} /> <span className="hidden-mobile">Stop</span></button>
          )}
          <button className="icon-btn" title="Clear" onClick={clearTerm}><IconErase size={16} /></button>
        </div>
      </div>
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}
