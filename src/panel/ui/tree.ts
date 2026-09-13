import { formatPath } from '../../shared/diff';
import { describeMarker, isMarker } from '../../shared/serialize';
import { copyWithToast, h } from './dom';

type Path = (string | number)[];

export interface TreeOptions {
  /** Levels expanded initially. */
  expandDepth?: number;
  /** Case-insensitive search over keys and primitive values. */
  query?: string;
  /** Hide nodes that neither match `query` nor contain a match. Children of a matching node are kept. */
  filter?: boolean;
  /** Prefix used when copying paths, e.g. the store name. */
  rootPath?: Path;
  rootLabel?: string;
}

export interface TreeResult {
  element: HTMLElement;
  matches: number;
  /** The search stopped at the node limit; filtering is skipped because unvisited nodes are unknown. */
  truncated: boolean;
}

const CHUNK = 200;
const MAX_SEARCH_NODES = 200_000;

interface ChildEntry {
  key: string | number;
  label?: string;
  value: unknown;
}

/** Renders a serialized value as a lazily expanding tree. */
export function renderTree(value: unknown, options: TreeOptions = {}): TreeResult {
  const expandDepth = options.expandDepth ?? 1;
  const query = options.query?.trim().toLowerCase() ?? '';
  const rootPath = options.rootPath ?? [];
  const { matches, ancestors, truncated } = query ? search(value, query) : { matches: new Set<string>(), ancestors: new Set<string>(), truncated: false };
  const filtering = Boolean(options.filter && query) && !truncated;

  const renderNode = (key: string | number | null, label: string | undefined, v: unknown, path: Path, depth: number, showAll: boolean): HTMLElement => {
    const id = pathKey(path);
    const isMatch = matches.has(id);
    const keepAll = showAll || isMatch;
    const all = childrenOf(v);
    const children =
      all && !keepAll
        ? all.filter((child) => {
            const childId = pathKey([...path, child.key]);
            return matches.has(childId) || ancestors.has(childId);
          })
        : all;

    const row = h(
      'div',
      { class: `tree-row${isMatch ? ' match' : ''}` },
      h('span', { class: 'toggle' }, children ? '▸' : ''),
      key !== null ? [h('span', { class: typeof key === 'number' ? 'key index' : 'key' }, label ?? String(key)), h('span', { class: 'colon' }, ': ')] : null,
      renderPreview(v, all),
      h(
        'span',
        { class: 'row-actions' },
        path.length > 0 || rootPath.length > 0
          ? h('button', { class: 'mini', title: 'Copy path', onClick: (e: MouseEvent) => (e.stopPropagation(), copyWithToast(formatPath([...rootPath, ...path]), 'Path copied')) }, 'path')
          : null,
        h('button', { class: 'mini', title: 'Copy value as JSON', onClick: (e: MouseEvent) => (e.stopPropagation(), copyWithToast(toJson(v), 'Value copied')) }, 'copy'),
      ),
    );
    const node = h('div', { class: 'tree-node' }, row);
    if (!children) return node;

    const container = h('div', { class: 'tree-children' });
    let rendered = 0;
    let open = false;

    const renderMore = () => {
      const end = Math.min(children.length, rendered + CHUNK);
      for (; rendered < end; rendered++) {
        const child = children[rendered];
        container.appendChild(renderNode(child.key, child.label, child.value, [...path, child.key], depth + 1, keepAll));
      }
      if (rendered < children.length) {
        const more = h('div', { class: 'tree-more' }, `Show ${Math.min(CHUNK, children.length - rendered)} more of ${children.length - rendered}`);
        more.addEventListener('click', () => {
          more.remove();
          renderMore();
        });
        container.appendChild(more);
      }
    };

    const setOpen = (value: boolean) => {
      open = value;
      if (open && rendered === 0) renderMore();
      node.classList.toggle('open', open);
      row.querySelector('.toggle')!.textContent = open ? '▾' : '▸';
    };

    row.addEventListener('click', () => setOpen(!open));
    node.appendChild(container);
    if (depth < expandDepth || ancestors.has(id)) setOpen(true);
    return node;
  };

  const element = h('div', { class: 'tree' }, renderNode(options.rootLabel ?? null, undefined, value, [], 0, !filtering));
  return { element, matches: matches.size, truncated };
}

function childrenOf(value: unknown): ChildEntry[] | null {
  if (Array.isArray(value)) return value.map((v, i) => ({ key: i, value: v }));
  if (typeof value !== 'object' || value === null) return null;
  if (isMarker(value)) {
    switch (value.$devkit) {
      case 'Map':
        return value.entries.map(([k, v], i) => ({ key: i, label: `${inlinePreview(k)} =>`, value: v }));
      case 'Set':
        return value.values.map((v, i) => ({ key: i, value: v }));
      case 'object':
        return Object.entries(value.value).map(([k, v]) => ({ key: k, value: v }));
      case 'Error':
        return value.stack ? [{ key: 'stack', value: value.stack }] : null;
      default:
        return null;
    }
  }
  const entries = Object.entries(value);
  return entries.map(([k, v]) => ({ key: k, value: v }));
}

function renderPreview(value: unknown, children: ChildEntry[] | null): HTMLElement {
  if (children) {
    const cls = 'preview';
    if (Array.isArray(value)) return h('span', { class: cls }, `Array(${value.length})`);
    if (isMarker(value)) return h('span', { class: `${cls} marker` }, describeMarker(value));
    const keys = Object.keys(value as object);
    const shown = keys.slice(0, 4).join(', ');
    return h('span', { class: cls }, `{${shown}${keys.length > 4 ? ', …' : ''}}`);
  }
  return renderLeaf(value);
}

export function renderLeaf(value: unknown): HTMLElement {
  if (typeof value === 'string') {
    const text = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    return h('span', { class: 'v-string', title: value.length > 500 ? `${value.length} characters` : undefined }, JSON.stringify(text));
  }
  if (typeof value === 'number') return h('span', { class: 'v-number' }, String(value));
  if (typeof value === 'boolean') return h('span', { class: 'v-boolean' }, String(value));
  if (value === null) return h('span', { class: 'v-null' }, 'null');
  if (isMarker(value)) return h('span', { class: 'marker' }, describeMarker(value));
  if (Array.isArray(value)) return h('span', { class: 'preview' }, `[]`);
  return h('span', { class: 'preview' }, `{}`);
}

/** Single-line preview used in diffs and map keys. */
export function inlinePreview(value: unknown, max = 80): string {
  let text: string;
  if (isMarker(value)) text = describeMarker(value);
  else if (Array.isArray(value)) text = `Array(${value.length})`;
  else if (typeof value === 'object' && value !== null) text = `{${Object.keys(value).slice(0, 4).join(', ')}${Object.keys(value).length > 4 ? ', …' : ''}}`;
  else text = JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function isExpandable(value: unknown): boolean {
  const children = childrenOf(value);
  return children !== null && children.length > 0;
}

function search(value: unknown, query: string): { matches: Set<string>; ancestors: Set<string>; truncated: boolean } {
  const matches = new Set<string>();
  const ancestors = new Set<string>();
  let visited = 0;
  let truncated = false;

  const walk = (key: string | number | null, label: string | undefined, v: unknown, path: Path): boolean => {
    if (visited++ > MAX_SEARCH_NODES) {
      truncated = true;
      return false;
    }
    let found = false;
    const children = childrenOf(v);
    if (key !== null && String(label ?? key).toLowerCase().includes(query)) found = true;
    if (!children && leafText(v).toLowerCase().includes(query)) found = true;
    if (found) matches.add(pathKey(path));

    let descendant = false;
    if (children) {
      for (const child of children) {
        if (walk(child.key, child.label, child.value, [...path, child.key])) descendant = true;
      }
    }
    if (descendant) ancestors.add(pathKey(path));
    return found || descendant;
  };

  walk(null, undefined, value, []);
  return { matches, ancestors, truncated };
}

function leafText(value: unknown): string {
  if (isMarker(value)) return describeMarker(value);
  if (typeof value === 'string') return value;
  return String(value);
}

function pathKey(path: Path): string {
  return JSON.stringify(path);
}

export function toJson(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
