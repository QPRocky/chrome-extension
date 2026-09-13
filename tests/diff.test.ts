import { describe, expect, it } from 'vitest';
import { diff, formatPath } from '../src/shared/diff';

describe('diff', () => {
  it('returns nothing for identical references', () => {
    const state = { a: { b: 1 } };
    expect(diff(state, state)).toEqual([]);
  });

  it('reports added, removed and changed keys with paths', () => {
    const before = { todos: [{ id: 1, done: false }], filter: 'all', legacy: true };
    const after = { todos: [{ id: 1, done: true }, { id: 2, done: false }], filter: 'all', user: 'x' };
    expect(diff(before, after)).toEqual([
      { path: ['todos', 0, 'done'], kind: 'changed', before: false, after: true },
      { path: ['todos', 1], kind: 'added', after: { id: 2, done: false } },
      { path: ['legacy'], kind: 'removed', before: true },
      { path: ['user'], kind: 'added', after: 'x' },
    ]);
  });

  it('does not descend into unchanged subtrees', () => {
    const shared = {
      get boom(): never {
        throw new Error('should not be read');
      },
    };
    expect(diff({ shared, n: 1 }, { shared, n: 2 })).toEqual([{ path: ['n'], kind: 'changed', before: 1, after: 2 }]);
  });

  it('treats type changes as a single change', () => {
    expect(diff({ a: [1] }, { a: { 0: 1 } })).toEqual([{ path: ['a'], kind: 'changed', before: [1], after: { 0: 1 } }]);
    expect(diff(undefined, { a: 1 })).toEqual([{ path: [], kind: 'changed', before: undefined, after: { a: 1 } }]);
  });

  it('caps the number of changes', () => {
    const before = Array.from({ length: 50 }, (_, i) => i);
    const after = before.map((n) => n + 1);
    expect(diff(before, after, { maxChanges: 10 })).toHaveLength(10);
  });
});

describe('formatPath', () => {
  it('formats identifiers, indexes and odd keys', () => {
    expect(formatPath(['todos', 0, 'title'])).toBe('todos[0].title');
    expect(formatPath(['entities', 'user-1', '$ok'])).toBe('entities["user-1"].$ok');
    expect(formatPath(['a'], 'state')).toBe('state.a');
    expect(formatPath([])).toBe('');
  });
});
