import { useState, useRef } from "react";
import type { FileEntry } from "../../types";
import { api } from "../../api/client";
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconPlus,
  IconTrash,
  IconDownload,
  IconUpload,
  IconLink,
} from "../Icon";
import { DropdownMenu } from "../DropdownMenu";
import "./FileTree.css";
import "../DropdownMenu.css";

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
  if (isDir) return open ? <IconFolderOpen size={15} /> : <IconFolder size={15} />;
  void name;
  return <IconFile size={15} />;
}

function TreeNode({ node, depth, onOpen, onRefresh }: NodeProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(node.name);
  const [uploading, setUploading] = useState(false);

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

  const handleDownload = () => {
    const url = api.files.download(node.path);
    window.open(url, "_blank");
  };

  const handleDownloadZip = async () => {
    if (!node.isDir) return;
    const url = api.files.downloadZip(node.path);
    window.open(url, "_blank");
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      await api.files.upload(node.path, file);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleUploadUrl = async () => {
    const url = prompt("Enter URL to download:");
    if (!url) return;
    setUploading(true);
    try {
      await api.files.uploadUrl(url, node.path);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  };

  const fileActions = [
    { label: "Download", onClick: handleDownload, icon: <IconDownload size={14} /> },
    { label: "Rename", onClick: () => setRenaming(true), icon: <IconEdit size={14} /> },
    { divider: true },
    { label: "Delete", onClick: doDelete, icon: <IconTrash size={14} />, danger: true },
  ];

  const folderActions = [
    { label: "New Folder", onClick: doMkdir, icon: <IconPlus size={14} /> },
    { label: "New File", onClick: doNewFile, icon: <IconFile size={14} /> },
    { divider: true },
    { label: "Download as ZIP", onClick: handleDownloadZip, icon: <IconDownload size={14} /> },
    { label: "Upload File", onClick: () => fileInputRef.current?.click(), icon: <IconUpload size={14} /> },
    { label: "Upload from URL", onClick: handleUploadUrl, icon: <IconLink size={14} /> },
    { divider: true },
    { label: "Rename", onClick: () => setRenaming(true), icon: <IconEdit size={14} /> },
    { label: "Delete", onClick: doDelete, icon: <IconTrash size={14} />, danger: true },
  ];

  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <li className="ft-node" style={{ paddingLeft: depth * 14 }}>
      <div className={"ft-row" + (busy ? " ft-busy" : "")} onClick={toggle}>
        <span className="ft-chevron">
          {node.isDir ? (expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />) : null}
        </span>
        <span className={"ft-icon" + (node.isDir ? " ft-icon-dir" : "")}>
          <TreeIcon name={node.name} isDir={node.isDir} open={expanded} />
        </span>
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
        <DropdownMenu
          items={node.isDir ? folderActions : fileActions}
          alignRight
        />
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
            e.target.value = "";
          }}
        />
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
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDownloadProject = () => {
    const url = api.files.downloadProject();
    window.open(url, "_blank");
  };

  const handleUploadProject = async (file: File) => {
    setUploading(true);
    try {
      await api.files.upload("/", file);
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleUploadUrlProject = async () => {
    const url = prompt("Enter URL to download:");
    if (!url) return;
    setUploading(true);
    try {
      await api.files.uploadUrl(url, "/");
      onRefresh();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setUploading(false);
    }
  };

  const headerActions = [
    { label: "Download Project as ZIP", onClick: handleDownloadProject, icon: <IconDownload size={14} /> },
    { divider: true },
    { label: "Upload File", onClick: () => fileInputRef.current?.click(), icon: <IconUpload size={14} /> },
    { label: "Upload from URL", onClick: handleUploadUrlProject, icon: <IconLink size={14} /> },
  ];

  if (loading) return <div className="filetree"><div className="ft-status">Loading...</div></div>;
  if (error) return <div className="filetree"><div className="ft-error">Error: {error}</div></div>;
  if (!entry) return <div className="filetree"><div className="ft-status">No workspace</div></div>;
  return (
    <div className="filetree">
      <div className="ft-header">
        <span className="ft-title">EXPLORER</span>
        <DropdownMenu items={headerActions} alignRight />
      </div>
      <div className="ft-root-label" title={root}>{root || "workspace"}</div>
      <ul className="ft-list">
        <TreeNode node={entry} depth={0} onOpen={onOpen} onRefresh={onRefresh} />
      </ul>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUploadProject(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
