import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { OnMount, Monaco } from "@monaco-editor/react";
import { api } from "../../api/client";
import type { FileContent, UISettings } from "../../types";
import "./Editor.css";

interface Props {
  filePath: string | null;
  ui: UISettings | null;
  onSaved?: (path: string, content: string) => void;
}

interface EditorState {
  path: string;
  content: string;
  language: string;
  dirty: boolean;
  savedContent: string;
}

export function CodeEditor({ filePath, ui, onSaved }: Props) {
  const [state, setState] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  useEffect(() => {
    if (!filePath) { setState(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const f = await api.files.read(filePath);
        if (cancelled) return;
        setState({
          path: f.path,
          content: f.content,
          language: f.language,
          dirty: false,
          savedContent: f.content,
        });
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filePath]);

  const save = useCallback(async (override?: { content: string; path: string }) => {
    if (!state && !override) return;
    const target = override ?? { content: state!.content, path: state!.path };
    try {
      await api.files.write(target.path, target.content);
      setState((s) => s && s.path === target.path
        ? { ...s, content: target.content, savedContent: target.content, dirty: false }
        : s);
      setSavedAt(new Date().toLocaleTimeString());
      onSaved?.(target.path, target.content);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  }, [state, onSaved]);

  const onMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      save();
    });
    editor.onDidChangeModelContent(() => {
      setState((s) => s ? { ...s, content: editor.getValue(), dirty: editor.getValue() !== s.savedContent } : s);
    });
  };

  const fontSize = ui?.fontSize ?? 14;
  const minimap = ui?.minimap ?? true;
  const wordWrap = ui?.wordWrap ? "on" : "off";
  const tabSize = ui?.tabSize ?? 2;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save]);

  return (
    <div className="editor-panel">
      <div className="editor-toolbar">
        <span className="editor-path">{state?.path ?? "no file selected"}</span>
        {state?.dirty && <span className="editor-dirty">modified</span>}
        <button
          className="editor-save"
          onClick={() => save()}
          disabled={!state}
        >
          Save (Ctrl+S)
        </button>
        {savedAt && <span className="editor-saved">saved {savedAt}</span>}
      </div>
      {loading && <div className="editor-status">Loading...</div>}
      {error && <div className="editor-error">Error: {error}</div>}
      {!filePath && !loading && (
        <div className="editor-placeholder">
          <h2>KS Code</h2>
          <p>Select a file from the Explorer to start editing.</p>
        </div>
      )}
      {state && (
        <Editor
          key={state.path}
          height="100%"
          path={state.path}
          defaultLanguage={state.language}
          defaultValue={state.content}
          onMount={onMount}
          theme={ui?.theme ?? "vs-dark"}
          options={{
            fontSize,
            minimap: { enabled: minimap },
            wordWrap,
            tabSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
          }}
        />
      )}
    </div>
  );
}
