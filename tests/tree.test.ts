// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderTree } from '../src/panel/ui/tree';

const state = {
  user: { name: 'Alice' },
  todos: [{ title: 'milk' }, { title: 'bread' }],
  settings: { theme: 'dark' },
};

function keys(element: HTMLElement): string[] {
  return [...element.querySelectorAll('.key')].map((el) => el.textContent ?? '');
}

describe('renderTree filter', () => {
  it('hides nodes that neither match nor contain a match', () => {
    const tree = renderTree(state, { query: 'milk', filter: true });
    expect(tree.matches).toBe(1);
    expect(keys(tree.element)).toEqual(['todos', '0', 'title']);
    expect(tree.element.textContent).toContain('"milk"');
    expect(tree.element.textContent).not.toContain('"bread"');
  });

  it('keeps the whole subtree of a matching node', () => {
    const tree = renderTree(state, { query: 'user', filter: true });
    expect(keys(tree.element)).toEqual(['user']);
    const userRow = [...tree.element.querySelectorAll<HTMLElement>('.tree-row')].find((row) => row.querySelector('.key')?.textContent === 'user')!;
    userRow.click();
    expect(keys(tree.element)).toEqual(['user', 'name']);
  });

  it('keeps original array indices', () => {
    const tree = renderTree(state, { query: 'bread', filter: true });
    expect(keys(tree.element)).toEqual(['todos', '1', 'title']);
  });

  it('renders nothing below the root when there are no matches', () => {
    const tree = renderTree(state, { query: 'zzz', filter: true });
    expect(tree.matches).toBe(0);
    expect(keys(tree.element)).toEqual([]);
  });

  it('only highlights without the filter option', () => {
    const tree = renderTree(state, { query: 'milk' });
    expect(keys(tree.element)).toEqual(expect.arrayContaining(['user', 'todos', 'settings', '0', '1']));
    expect(tree.element.querySelectorAll('.tree-row.match')).toHaveLength(1);
  });
});
