import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './icons.js';

export function Modal({
  title,
  titleId,
  onClose,
  closeDisabled = false,
  children,
}: {
  title: string;
  titleId: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    // Dialog content can name its own first focus target (search fields, name inputs).
    element?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => element?.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="modal-close" onClick={onClose} disabled={closeDisabled} aria-label={`Close ${title}`} title="Close">
          <Icon name="close" size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
