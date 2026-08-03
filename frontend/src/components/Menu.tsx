import { useEffect, useRef, useState, type ReactNode } from "react";
import "./Menu.css";

export interface MenuItem {
  key: string;
  label: string;
  danger?: boolean;
  onSelect?: () => void;
}

interface Props {
  items: MenuItem[];
  trigger?: ReactNode;
  align?: "left" | "right";
  className?: string;
  ariaLabel?: string;
}

export function Menu({ items, trigger, align = "right", className, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      className={"menu-wrap" + (open ? " menu-open" : "") + (className ? " " + className : "")}
      ref={ref}
    >
      <button
        type="button"
        className="menu-trigger"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={ariaLabel ?? "Open menu"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger ?? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        )}
      </button>
      {open && (
        <ul className={"menu-list glass-strong" + (align === "left" ? " menu-left" : " menu-right")} role="menu">
          {items.map((it) => (
            <li
              key={it.key}
              role="menuitem"
              className={"menu-item" + (it.danger ? " menu-danger" : "")}
              onClick={() => { setOpen(false); it.onSelect?.(); }}
            >
              {it.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
