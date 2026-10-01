import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

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
        <button type="button" onClick={onClose} disabled={closeDisabled} aria-label={`Close ${title}`}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
