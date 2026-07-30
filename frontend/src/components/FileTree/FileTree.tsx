import { useState } from "react";
import type { FileEntry } from "../../types";
import { api } from "../../api/client";
import "./FileTree.css";

interface Props {
  entry: FileEntry | null;
  root: string;
  loading: boolean;
  error: string | null;
  onOpen: (path: string) => void;
  onRefresh: (path?: string) => void;
}

interface NodeProps {
  node: FileEntry;
  depth: number;
  onOpen: (path: string) => void;
  onRefresh: (path?: string) => void;
}

function TreeIcon({ name, isDir, open }: { name: string; isDir: boolean; open: boolean }) {
  if (isDir) return <span className="ft-icon">{open ? "\u{1F4C2}" : "\u{1F4C1}"}</span>;
  const ext = name.split(".").pop()?.toLowerCase();
  const icon = ext === "go" ? "\u{1F439}"
    : ext === "ts" || ext === "tsx" ? "\u{1F539}"
    : ext === "js" || ext === "jsx" ? "\u{1F7E2}"
    : ext === "json" ? "\u{1F5C3}"
    : ext === "md" ? "\u{1F4DD}"
    : "\u{1F4C4}";
  return <span className="ft-icon">{icon}</span>;
}

function TreeNode({ node, depth, onOpen, onRefresh }: NodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(node.name);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.isDir) setExpanded((v) => !v);
    else onOpen(node.path);
  };

  const doMkdir = async () => {
    const name = prompt("New folder name:");
    if (!name) return;
    setBusy(true);
    try {
      await api.files.mkdir(node.path === "/" ? "/" + name : node.path + "/" + name);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doNewFile = async () => {
    const name = prompt("New file name:");
    if (!name) return;
    setBusy(true);
    try {
      const p = node.path === "/" ? "/" + name : node.path + "/" + name;
      await api.files.write(p, "");
      onOpen(p);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!confirm(`Delete ${node.path}?`)) return;
    setBusy(true);
    try {
      await api.files.remove(node.path);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    const dir = node.path.substring(0, node.path.lastIndexOf("/"));
    const newPath = dir + "/" + newName;
    if (newPath === node.path) { setRenaming(false); return; }
    setBusy(true);
    try {
      await api.files.rename(node.path, newPath);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
      setRenaming(false);
    }
  };

  return (
    <li className="ft-node" style={{ paddingLeft: depth * 14 }}>
      <div className={"ft-row" + (busy ? " ft-busy" : "")} onClick={toggle}>
        <TreeIcon name={node.name} isDir={node.isDir} open={expanded} />
        {renaming ? (
          <input
            className="ft-rename"
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") doRename();
              if (e.key === "Escape") { setRenaming(false); setNewName(node.name); }
            }}
          />
        ) : (
          <span className={"ft-name" + (node.isDir ? " ft-dir" : "")}>
            {node.name}
          </span>
        )}
        <span className="ft-actions">
          <button title="New folder" onClick={(e) => { e.stopPropagation(); doMkdir(); }}>+</button>
          <button title="New file" onClick={(e) => { e.stopPropagation(); doNewFile(); }}>+f</button>
          <button title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(true); }}>E</button>
          <button title="Delete" onClick={(e) => { e.stopPropagation(); doDelete(); }}>x</button>
        </span>
      </div>
      {node.isDir && expanded && node.children && (
        <ul className="ft-children">
          {node.children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              onOpen={onOpen}
              onRefresh={onRefresh}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree({ entry, root, loading, error, onOpen, onRefresh }: Props) {
  if (loading) return <div className="filetree"><div className="ft-status">Loading...</div></div>;
  if (error) return <div className="filetree"><div className="ft-error">Error: {error}</div></div>;
  if (!entry) return <div className="filetree"><div className="ft-status">No workspace</div></div>;
  return (
    <div className="filetree">
      <div className="ft-header">
        <span className="ft-title">EXPLORER</span>
        <button className="ft-refresh" title="Refresh" onClick={() => onRefresh()}>refresh</button>
      </div>
      <div className="ft-root-label" title={root}>{root}</div>
      <ul className="ft-list">
        <TreeNode node={entry} depth={0} onOpen={onOpen} onRefresh={onRefresh} />
      </ul>
    </div>
  );
}
