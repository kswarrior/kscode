import { useState } from "react";
import { api } from "../../api/client";
import type { SearchResult } from "../../types";
import "./SearchPanel.css";

interface Props {
  onOpen: (path: string, line?: number) => void;
}

export function SearchPanel({ onOpen }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.files.search(q);
      setResults(r.results);
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="search-panel">
      <form onSubmit={search} className="search-form">
        <input
          autoFocus
          type="text"
          placeholder="Search in workspace..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : "Search"}
        </button>
      </form>
      {error && <div className="search-error">{error}</div>}
      <div className="search-results">
        {results.length === 0 && !loading && q && (
          <div className="search-empty">No matches.</div>
        )}
        {results.map((r, i) => (
          <div
            key={i}
            className="search-item"
            onClick={() => onOpen(r.path, r.line)}
          >
            <div className="search-path">
              {r.path}<span className="search-line">:{r.line}</span>
            </div>
            <div className="search-preview">{r.preview}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
