// @vitest-environment jsdom
import { configureStore, createSlice } from '@reduxjs/toolkit';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, it } from 'vitest';
import { findStoresInReactTree } from '../src/content/redux/fiber';
import { Registry } from '../src/content/redux/registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const counter = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: { inc: (state) => void state.value++ },
});

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function renderApp() {
  const store = configureStore({ reducer: { counter: counter.reducer }, devTools: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Provider, { store, children: createElement('p', null, 'app') })));
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return store;
}

describe('React tree fallback', () => {
  it('finds stores passed to react-redux Provider', async () => {
    const store = await renderApp();
    expect(findStoresInReactTree(document)).toEqual([store]);
  });

  it('registers found stores in limited mode', async () => {
    const store = await renderApp();
    const registry = new Registry({ emit: () => {}, scan: () => findStoresInReactTree(document), schedule: (fn) => fn() });

    const { stores } = registry.handle('init', undefined);
    expect(stores).toEqual([expect.objectContaining({ id: 'store-1', mode: 'limited' })]);

    store.dispatch(counter.actions.inc());
    store.dispatch((dispatch) => dispatch(counter.actions.inc()));

    const { histories } = registry.handle('init', undefined);
    expect(histories['store-1'].entries.map((e) => e.type)).toEqual(['@@INIT', 'counter/inc', '(state changed)']);
    expect(registry.handle('getEntry', { storeId: 'store-1', entryId: 2, part: 'state' })).toEqual({ counter: { value: 2 } });

    expect(() => registry.handle('jump', { storeId: 'store-1', entryId: 0 })).toThrow(/enhancer hook/);
    expect(() => registry.handle('importState', { storeId: 'store-1', state: {} })).toThrow(/enhancer hook/);

    // Scanning again does not register the same store twice.
    expect(registry.handle('detect', undefined).stores).toHaveLength(1);
  });
});
