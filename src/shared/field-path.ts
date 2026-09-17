/**
 * redux-form field names are accessor expressions: `address.street`,
 * `items[0].code`. These helpers turn them into path segments and read values
 * out of a plain state object with them.
 */

/** Parses `items[0].code` into `['items', 0, 'code']`. */
export function parsePath(name: string): (string | number)[] {
  const path: (string | number)[] = [];
  const pattern = /\[(\d+)\]|\[["']([^"']*)["']\]|([^.[\]]+)/g;
  for (const [, index, quoted, plain] of name.matchAll(pattern)) {
    if (index !== undefined) path.push(Number(index));
    else path.push(quoted ?? plain);
  }
  return path;
}

/** Reads the value at `path`, or undefined when any step is missing. */
export function getIn(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/** Reads the value of a redux-form field name. */
export function getField(values: unknown, name: string): unknown {
  return getIn(values, parsePath(name));
}

/**
 * True when `name` addresses something inside `parent`, e.g. `items[0].code`
 * inside `items`. Used to skip FieldArray children, which are saved as part of
 * the array itself.
 */
export function isChildField(name: string, parent: string): boolean {
  return name.startsWith(`${parent}.`) || name.startsWith(`${parent}[`);
}
