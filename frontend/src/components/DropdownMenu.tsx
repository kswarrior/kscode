import { useEffect, useRef, useState } from "react";
import { IconMoreVertical } from "./Icon";

interface MenuItem {
  label?: string;
  onClick?: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

interface DropdownMenuProps {
  items: MenuItem[];
  trigger?: React.ReactNode;
  alignRight?: boolean;
  closeOnClick?: boolean;
}

export function DropdownMenu({
  items,
  trigger = <IconMoreVertical size={16} />,
  alignRight = false,
  closeOnClick = true,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled || item.divider || !item.onClick) return;
    item.onClick();
    if (closeOnClick) setOpen(false);
  };

  return (
    <div className="dropdown-menu-wrapper" ref={ref}>
      <button
        className="dropdown-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="More options"
        aria-expanded={open}
        aria-haspopup="true"
      >
        {trigger}
      </button>
      {open && (
        <div
          className={"dropdown-menu" + (alignRight ? " dropdown-menu-right" : "")}
          role="menu"
        >
          {items.map((item, idx) => (
            item.divider ? (
              <div key={`divider-${idx}`} className="dropdown-divider" role="separator" />
            ) : (
              <button
                key={idx}
                className={`dropdown-item` + (item.danger ? " dropdown-item-danger" : "") + (item.disabled ? " dropdown-item-disabled" : "")}
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
                role="menuitem"
              >
                {item.icon && <span className="dropdown-item-icon">{item.icon}</span>}
                <span className="dropdown-item-label">{item.label}</span>
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}