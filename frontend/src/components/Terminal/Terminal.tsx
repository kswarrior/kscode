import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/client";
import type { ShellEvent, ShellStartResponse } from "../../types";
import "./Terminal.css";

interface Props {
  cwd: string;
  fontSize?: number;
}

export function TerminalPanel({ cwd, fontSize = 14 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);

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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.writeln("\x1b[36mKS Code Terminal\x1b[0m");
    term.writeln("Click \x1b[1mStart\x1b[0m to launch a shell session.");

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

  const start = async () => {
    const term = termRef.current!;
    const fit = fitRef.current!;
    fit.fit();
    try {
      setStatus("starting");
      const res: ShellStartResponse = await api.shell.start({
        cols: term.cols,
        rows: term.rows,
        cwd,
      });
      setSessionId(res.id);
      const ws = new WebSocket(api.shell.wsUrl(res.id));
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        term.focus();
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
        }
      };
      ws.onerror = () => {
        setStatus("error");
        term.writeln(`\x1b[31m[websocket error]\x1b[0m`);
      };
      ws.onclose = () => {
        if (status !== "exited") setStatus("closed");
      };

      const onTermData = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      };
      const dataDisposable = term.onData(onTermData);
      (term as any).__cleanup_data = () => { dataDisposable.dispose(); };
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
        <span className="terminal-title">TERMINAL</span>
        <span className="terminal-status" style={{ color: statusColor }}>
          {status}{sessionId ? ` (${sessionId.slice(0, 8)})` : ""}
        </span>
        <div className="terminal-buttons">
          {status !== "connected" && status !== "starting" && (
            <button onClick={start}>Start</button>
          )}
          {status === "connected" && (
            <button onClick={stop}>Stop</button>
          )}
          <button onClick={clearTerm}>Clear</button>
        </div>
      </div>
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}
