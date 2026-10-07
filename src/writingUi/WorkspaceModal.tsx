import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export function WorkspaceModal({
  title,
  children,
  footer,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      const all = document.querySelectorAll('[data-writing-modal]');
      if (all[all.length - 1] !== panel.current) return;
      if (event.key === 'Escape' && !busyRef.current && !event.isComposing) {
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const controls = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]'
          ) ?? []
        ).filter(element => element.offsetParent !== null);
        const first = controls[0],
          last = controls[controls.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === panel.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[90] bg-black/50 p-3 md:p-6 flex items-center justify-center">
      <div
        ref={panel}
        data-writing-modal
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-6xl max-h-[94vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl text-gray-900 dark:text-gray-100 flex flex-col outline-none"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-gray-700 gap-4">
          <h2 className="text-lg font-semibold truncate">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 p-5">{children}</div>
        {footer && <div className="border-t dark:border-gray-700 p-4 flex-shrink-0">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
