import { h } from './dom';

export interface SplitOptions {
  /** Initial size of the first pane in percent. */
  initial?: number;
  min?: number;
  storageKey?: string;
}

/** Horizontal two-pane layout with a draggable divider. */
export function createSplit(first: HTMLElement, second: HTMLElement, options: SplitOptions = {}): HTMLElement {
  const min = options.min ?? 15;
  let size = readSize(options.storageKey) ?? options.initial ?? 50;

  const firstPane = h('div', { class: 'split-pane' }, first);
  const secondPane = h('div', { class: 'split-pane' }, second);
  const handle = h('div', { class: 'split-handle', role: 'separator', 'aria-orientation': 'vertical' });
  const root = h('div', { class: 'split' }, firstPane, handle, secondPane);

  const apply = () => {
    firstPane.style.flexBasis = `${size}%`;
    secondPane.style.flexBasis = `${100 - size}%`;
  };
  apply();

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    root.classList.add('dragging');
    const rect = root.getBoundingClientRect();

    const onMove = (e: PointerEvent) => {
      size = Math.min(100 - min, Math.max(min, ((e.clientX - rect.left) / rect.width) * 100));
      apply();
    };
    const onUp = () => {
      root.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      writeSize(options.storageKey, size);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });

  return root;
}

function readSize(key?: string): number | null {
  if (!key) return null;
  try {
    const value = Number(localStorage.getItem(key));
    return value > 0 && value < 100 ? value : null;
  } catch {
    return null;
  }
}

function writeSize(key: string | undefined, size: number): void {
  if (!key) return;
  try {
    localStorage.setItem(key, String(size));
  } catch {
    // storage unavailable
  }
}
