export type Child = Node | string | number | null | undefined | false | Child[];

type EventProps = {
  [K in keyof HTMLElementEventMap as `on${Capitalize<K>}`]?: (event: HTMLElementEventMap[K]) => void;
};

export type Props = EventProps & {
  class?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  [attr: string]: unknown;
};

/** Tiny hyperscript helper: h('button', { class: 'btn', onClick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style') {
        if (typeof value === 'string') el.setAttribute('style', value);
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el && typeof value !== 'string') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function button(label: Child, onClick: (event: MouseEvent) => void, props: Props = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn', ...props, onClick }, label);
}

export function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void, title?: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check', title }, input, label);
}

export function select<T extends string>(options: [T, string][], value: T, onChange: (value: T) => void, title?: string): HTMLSelectElement {
  const el = h('select', { title }, ...options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function downloadFile(filename: string, content: BlobPart, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // DevTools panels often lack clipboard permission; fall back to execCommand.
  }
  const area = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
  area.value = text;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Clipboard is not available');
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 5000 : 2000);
}

export async function copyWithToast(text: string, what = 'Copied'): Promise<void> {
  try {
    await copyText(text);
    toast(what);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function timestampForFile(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function safeFilePart(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'page';
}
