/**
 * Converts arbitrary JS values into JSON-compatible data. Values JSON cannot
 * represent become marker objects `{ $devkit: <kind>, ... }` which `revive`
 * turns back into real values where that is possible.
 */

export const MARKER = '$devkit';

export type Marker =
  | { $devkit: 'undefined' }
  | { $devkit: 'number'; value: 'NaN' | 'Infinity' | '-Infinity' }
  | { $devkit: 'bigint'; value: string }
  | { $devkit: 'Date'; value: string }
  | { $devkit: 'RegExp'; source: string; flags: string }
  | { $devkit: 'Map'; entries: [unknown, unknown][] }
  | { $devkit: 'Set'; values: unknown[] }
  | { $devkit: 'Error'; name: string; message: string; stack?: string }
  | { $devkit: 'function'; name: string }
  | { $devkit: 'symbol'; description: string }
  | { $devkit: 'circular'; path: string }
  | { $devkit: 'truncated'; kind: string; size?: number }
  | { $devkit: 'opaque'; kind: string; preview?: string }
  | { $devkit: 'object'; value: Record<string, unknown> }
  | { $devkit: 'unreadable'; message: string };

export interface SerializeOptions {
  /** Objects deeper than this are replaced with a truncated marker. */
  maxDepth?: number;
  /** Stop descending after this many values have been visited. */
  maxNodes?: number;
}

export function isMarker(value: unknown): value is Marker {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[MARKER] === 'string'
  );
}

export function serialize(value: unknown, options: SerializeOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? Infinity;
  const maxNodes = options.maxNodes ?? 500_000;
  const ancestors = new Map<object, string>();
  let nodes = 0;

  const walk = (v: unknown, depth: number, path: string): unknown => {
    nodes++;
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        if (Number.isFinite(v)) return v;
        return { [MARKER]: 'number', value: String(v) };
      case 'undefined':
        return { [MARKER]: 'undefined' };
      case 'bigint':
        return { [MARKER]: 'bigint', value: v.toString() };
      case 'symbol':
        return { [MARKER]: 'symbol', description: v.description ?? '' };
      case 'function':
        return { [MARKER]: 'function', name: v.name || 'anonymous' };
    }
    if (v === null) return null;
    const obj = v as object;

    const tag = Object.prototype.toString.call(obj).slice(8, -1);
    if (tag === 'Date') {
      const time = (obj as Date).getTime();
      return { [MARKER]: 'Date', value: Number.isNaN(time) ? 'Invalid Date' : (obj as Date).toISOString() };
    }
    if (tag === 'RegExp') return { [MARKER]: 'RegExp', source: (obj as RegExp).source, flags: (obj as RegExp).flags };
    if (isError(obj)) return { [MARKER]: 'Error', name: obj.name, message: obj.message, stack: obj.stack };

    const opaque = opaqueKind(obj, tag);
    if (opaque) return opaque;

    const seenAt = ancestors.get(obj);
    if (seenAt !== undefined) return { [MARKER]: 'circular', path: seenAt };

    if (depth >= maxDepth || nodes >= maxNodes) {
      return { [MARKER]: 'truncated', kind: containerKind(obj, tag), size: containerSize(obj, tag) };
    }

    ancestors.set(obj, path);
    try {
      if (Array.isArray(obj)) {
        return obj.map((item, i) => walk(item, depth + 1, `${path}[${i}]`));
      }
      if (tag === 'Map') {
        const entries: [unknown, unknown][] = [];
        let i = 0;
        for (const [k, val] of obj as Map<unknown, unknown>) {
          entries.push([walk(k, depth + 1, `${path}.<key ${i}>`), walk(val, depth + 1, `${path}.<value ${i}>`)]);
          i++;
        }
        return { [MARKER]: 'Map', entries };
      }
      if (tag === 'Set') {
        const values: unknown[] = [];
        let i = 0;
        for (const item of obj as Set<unknown>) values.push(walk(item, depth + 1, `${path}.<${i++}>`));
        return { [MARKER]: 'Set', values };
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        try {
          out[key] = walk((obj as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
        } catch (err) {
          out[key] = { [MARKER]: 'unreadable', message: errorMessage(err) };
        }
      }
      // Escape plain objects that happen to look like markers.
      if (MARKER in out) return { [MARKER]: 'object', value: out };
      return out;
    } finally {
      ancestors.delete(obj);
    }
  };

  return walk(value, 0, '$');
}

/** Inverse of `serialize` for markers that describe reconstructible values. */
export function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value !== 'object' || value === null) return value;
  if (!isMarker(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v);
    return out;
  }
  switch (value.$devkit) {
    case 'undefined':
      return undefined;
    case 'number':
      return Number(value.value);
    case 'bigint':
      return BigInt(value.value);
    case 'Date':
      return new Date(value.value);
    case 'RegExp':
      return new RegExp(value.source, value.flags);
    case 'Map':
      return new Map(value.entries.map(([k, v]) => [revive(k), revive(v)]));
    case 'Set':
      return new Set(value.values.map(revive));
    case 'Error': {
      const err = new Error(value.message);
      err.name = value.name;
      if (value.stack) err.stack = value.stack;
      return err;
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.value)) out[k] = revive(v);
      return out;
    }
    default:
      // functions, symbols, circular refs etc. cannot be reconstructed
      return value;
  }
}

/**
 * Lowercase text of all keys and leaf values in `value`, one per line, for
 * substring search. Lines keep matches from spanning a key and its value.
 */
export function searchText(value: unknown, maxNodes = 5000): string {
  const parts: string[] = [];
  const walkObject = (obj: object): void => {
    for (const [key, child] of Object.entries(obj)) {
      parts.push(key);
      walk(child);
    }
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return void parts.push(String(v));
    if (!isMarker(v)) return walkObject(v);
    if (v.$devkit === 'Map') return v.entries.forEach(([k, child]) => (walk(k), walk(child)));
    if (v.$devkit === 'Set') return v.values.forEach(walk);
    // The escaped object itself looks like a marker, so it must not be walked as one.
    if (v.$devkit === 'object') return walkObject(v.value);
    parts.push(describeMarker(v));
  };
  walk(serialize(value, { maxNodes }));
  return parts.join('\n').toLowerCase();
}

/** Short human readable description of a marker, used by the UI. */
export function describeMarker(m: Marker): string {
  switch (m.$devkit) {
    case 'undefined':
      return 'undefined';
    case 'number':
      return m.value;
    case 'bigint':
      return `${m.value}n`;
    case 'Date':
      return m.value;
    case 'RegExp':
      return `/${m.source}/${m.flags}`;
    case 'Map':
      return `Map(${m.entries.length})`;
    case 'Set':
      return `Set(${m.values.length})`;
    case 'Error':
      return `${m.name}: ${m.message}`;
    case 'function':
      return `ƒ ${m.name}()`;
    case 'symbol':
      return `Symbol(${m.description})`;
    case 'circular':
      return `[Circular → ${m.path}]`;
    case 'truncated':
      return `${m.kind}${m.size !== undefined ? `(${m.size})` : ''} …`;
    case 'opaque':
      return m.preview ? `${m.kind} ${m.preview}` : m.kind;
    case 'object':
      return 'Object';
    case 'unreadable':
      return `<unreadable: ${m.message}>`;
  }
}

function isError(obj: object): obj is Error {
  return obj instanceof Error || Object.prototype.toString.call(obj) === '[object Error]';
}

function opaqueKind(obj: object, tag: string): Marker | null {
  if (tag === 'Promise' || tag === 'WeakMap' || tag === 'WeakSet' || tag === 'WeakRef') {
    return { [MARKER]: 'opaque', kind: tag };
  }
  if (tag === 'ArrayBuffer') return { [MARKER]: 'opaque', kind: 'ArrayBuffer', preview: `(${(obj as ArrayBuffer).byteLength} bytes)` };
  if (ArrayBuffer.isView(obj)) return { [MARKER]: 'opaque', kind: tag, preview: `(${obj.byteLength} bytes)` };
  if (tag === 'Window' || tag === 'global') return { [MARKER]: 'opaque', kind: 'Window' };
  const node = obj as { nodeType?: unknown; nodeName?: unknown; id?: unknown };
  if (typeof node.nodeType === 'number' && typeof node.nodeName === 'string') {
    const id = typeof node.id === 'string' && node.id ? `#${node.id}` : '';
    return { [MARKER]: 'opaque', kind: 'Node', preview: `<${node.nodeName.toLowerCase()}${id}>` };
  }
  return null;
}

function containerKind(obj: object, tag: string): string {
  if (Array.isArray(obj)) return 'Array';
  if (tag === 'Map' || tag === 'Set') return tag;
  return 'Object';
}

function containerSize(obj: object, tag: string): number {
  if (Array.isArray(obj)) return obj.length;
  if (tag === 'Map' || tag === 'Set') return (obj as Map<unknown, unknown>).size;
  return Object.keys(obj).length;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
