export interface Change {
  path: (string | number)[];
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface DiffOptions {
  maxChanges?: number;
  maxDepth?: number;
}

/**
 * Structural diff of two values. Identical references are skipped without
 * descending, which keeps diffs of immutable Redux states cheap.
 */
export function diff(before: unknown, after: unknown, options: DiffOptions = {}): Change[] {
  const maxChanges = options.maxChanges ?? 1000;
  const maxDepth = options.maxDepth ?? 64;
  const changes: Change[] = [];

  const walk = (a: unknown, b: unknown, path: (string | number)[]): void => {
    if (changes.length >= maxChanges || Object.is(a, b)) return;

    if (path.length < maxDepth) {
      if (Array.isArray(a) && Array.isArray(b)) {
        const shared = Math.min(a.length, b.length);
        for (let i = 0; i < shared; i++) walk(a[i], b[i], [...path, i]);
        for (let i = shared; i < b.length && changes.length < maxChanges; i++) {
          changes.push({ path: [...path, i], kind: 'added', after: b[i] });
        }
        for (let i = shared; i < a.length && changes.length < maxChanges; i++) {
          changes.push({ path: [...path, i], kind: 'removed', before: a[i] });
        }
        return;
      }
      if (isRecord(a) && isRecord(b)) {
        for (const key of Object.keys(a)) {
          if (changes.length >= maxChanges) return;
          if (Object.prototype.hasOwnProperty.call(b, key)) walk(a[key], b[key], [...path, key]);
          else changes.push({ path: [...path, key], kind: 'removed', before: a[key] });
        }
        for (const key of Object.keys(b)) {
          if (changes.length >= maxChanges) return;
          if (!Object.prototype.hasOwnProperty.call(a, key)) changes.push({ path: [...path, key], kind: 'added', after: b[key] });
        }
        return;
      }
    }

    changes.push({ path, kind: 'changed', before: a, after: b });
  };

  walk(before, after, []);
  return changes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Formats a path as a JS accessor expression, e.g. `todos[0].title`. */
export function formatPath(path: readonly (string | number)[], root = ''): string {
  let out = root;
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(segment)) out += out ? `.${segment}` : segment;
    else out += `[${JSON.stringify(segment)}]`;
  }
  return out;
}
