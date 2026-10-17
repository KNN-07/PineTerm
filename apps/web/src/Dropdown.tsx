import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * A TradingView-style popover anchored to a toolbar button. It stays open while the user
 * works inside it (forms, inputs) and closes on outside press, Escape, or `close()`.
 * The popover is fixed-positioned so scrolling docks never clip it.
 */
export function Dropdown({ label, title, ariaLabel, className = '', buttonClassName = '', align = 'left', disabled = false, children }: {
  label: ReactNode; title: string; ariaLabel?: string; className?: string; buttonClassName?: string; align?: 'left' | 'right'; disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const place = () => {
      const rect = button.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upward = below < 260 && above > below;
      const horizontal = align === 'right' ? { right: Math.max(8, window.innerWidth - rect.right) } : { left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)) };
      setPosition(upward ? { ...horizontal, bottom: window.innerHeight - rect.top + 4, maxHeight: above } : { ...horizontal, top: rect.bottom + 4, maxHeight: below });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      event.preventDefault(); setOpen(false); button.current?.focus();
    };
    document.addEventListener('pointerdown', press); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', press); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const close = () => { setOpen(false); button.current?.focus(); };
  return <div className={`tv-dropdown ${className}`} ref={root}>
    <button type="button" ref={button} className={`tv-dropdown-button ${buttonClassName}`} title={title} aria-label={ariaLabel} aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen((value) => !value)}>{label}</button>
    {open && <div id={id} className="tv-popover" style={position} role="group" aria-label={title}>{children(close)}</div>}
  </div>;
}

export function MenuItem({ icon, children, hint, danger = false, checked, disabled = false, onSelect }: {
  icon?: ReactNode; children: ReactNode; hint?: ReactNode; danger?: boolean; checked?: boolean; disabled?: boolean; onSelect: () => void;
}) {
  return <button type="button" className={`tv-menu-item ${danger ? 'is-danger' : ''}`} disabled={disabled} aria-pressed={checked} onClick={onSelect}>
    <span className="tv-menu-icon">{icon}</span><span className="tv-menu-label">{children}</span>{hint && <span className="tv-menu-hint">{hint}</span>}
  </button>;
}
