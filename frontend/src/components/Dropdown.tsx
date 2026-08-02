import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconChevronDown } from "./Icon";
import "./Dropdown.css";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
}

interface Props<T extends string> {
  value: T | "";
  onChange: (value: T) => void;
  options: DropdownOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function Dropdown<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  label,
  className,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const current = options.find((o) => o.value === value);

  return (
    <div
      className={
        "dd" +
        (open ? " dd-open" : "") +
        (disabled ? " dd-disabled" : "") +
        (className ? " " + className : "")
      }
      ref={wrapRef}
    >
      {label ? <span className="dd-label">{label}</span> : null}
      <button
        type="button"
        className="dd-trigger"
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={"dd-value" + (current ? "" : " dd-placeholder")}>
          {current && current.icon ? current.icon : null}
          {current ? current.label : placeholder}
        </span>
        <IconChevronDown size={14} />
      </button>

      {open ? (
        <ul className="dd-menu glass-strong" role="listbox">
          {options.map((opt) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={
                "dd-option" + (opt.value === value ? " dd-selected" : "")
              }
              onClick={() => {
                onChange(opt.value);
                close();
              }}
            >
              <span className="dd-option-main">
                {opt.icon ? (
                  <span className="dd-option-icon">{opt.icon}</span>
                ) : null}
                <span>
                  <span className="dd-option-label">{opt.label}</span>
                  {opt.description ? (
                    <span className="dd-option-desc">{opt.description}</span>
                  ) : null}
                </span>
              </span>
              {opt.value === value ? (
                <span className="dd-check" aria-hidden="true">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20,6 9,17 4,12" />
                  </svg>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
