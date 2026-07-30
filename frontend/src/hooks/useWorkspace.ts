import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FileEntry } from "../types";

export function useWorkspace() {
  const [root, setRoot] = useState<string>("");
  const [tree, setTree] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (path = "/") => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.files.tree(path, 8);
      setRoot(res.root);
      setTree(res.entry);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh("/"); }, [refresh]);

  return { root, tree, loading, error, refresh };
}
