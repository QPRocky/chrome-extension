// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { PageEvent, SerializedChange } from '../src/shared/messages';
import { installReduxGlobals } from '../src/content/redux/enhancer';
import { Registry } from '../src/content/redux/registry';

const events: PageEvent[] = [];
const registry = new Registry({ emit: (e) => events.push(e), schedule: (fn) => fn() });
const win = window as any;

// RTK reads the Redux DevTools globals when its module is evaluated, exactly like
// on a real page where the content script runs at document_start.
let RTK: typeof import('@reduxjs/toolkit');
let redux: typeof import('redux');

beforeAll(async () => {
  installReduxGlobals(win, registry);
  RTK = await import('@reduxjs/toolkit');
  redux = await import('redux');
  registry.handle('init', undefined);
});

function makeSlice() {
  return RTK.createSlice({
    name: 'todos',
    initialState: { items: [] as string[], filter: 'all' },
    reducers: {
      add: (state, action: { payload: string }) => void state.items.push(action.payload),
      setFilter: (state, action: { payload: string }) => void (state.filter = action.payload),
    },
  });
}

function latestStoreId(): string {
  const list = registry.list();
  return list[list.length - 1].id;
}

function historyTypes(storeId: string): string[] {
  const { histories } = registry.handle('init', undefined);
  return histories[storeId].entries.map((e) => e.type);
}

describe('enhancer hook with Redux Toolkit', () => {
  it('registers stores created with configureStore and records plain actions only', () => {
    const slice = makeSlice();
    const store = RTK.configureStore({ reducer: { todos: slice.reducer } });
    const storeId = latestStoreId();
    expect(registry.list().find((s) => s.id === storeId)).toMatchObject({ mode: 'hooked', jumpedTo: null });

    store.dispatch(slice.actions.add('a'));
    store.dispatch((dispatch) => {
      dispatch(slice.actions.add('b'));
      dispatch(slice.actions.setFilter('done'));
    });

    expect(historyTypes(storeId)).toEqual(['@@INIT', 'todos/add', 'todos/add', 'todos/setFilter']);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'actions', storeId }));
  });

  it('serves actions, states and diffs for history entries', () => {
    const slice = makeSlice();
    const store = RTK.configureStore({ reducer: { todos: slice.reducer } });
    const storeId = latestStoreId();
    store.dispatch(slice.actions.add('milk'));

    expect(registry.handle('getEntry', { storeId, entryId: 1, part: 'action' })).toEqual({ type: 'todos/add', payload: 'milk' });
    expect(registry.handle('getEntry', { storeId, entryId: 1, part: 'state' })).toEqual({ todos: { items: ['milk'], filter: 'all' } });
    const changes = registry.handle('getEntry', { storeId, entryId: 1, part: 'diff' }) as SerializedChange[];
    expect(changes).toEqual([{ path: ['todos', 'items', 0], kind: 'added', after: 'milk', before: undefined }]);
  });

  it('jumps to earlier states and resumes the latest one', () => {
    const slice = makeSlice();
    const store = RTK.configureStore({ reducer: { todos: slice.reducer } });
    const storeId = latestStoreId();
    store.dispatch(slice.actions.add('a'));
    store.dispatch(slice.actions.add('b'));

    registry.handle('jump', { storeId, entryId: 1 });
    expect(store.getState().todos.items).toEqual(['a']);
    expect(registry.list().find((s) => s.id === storeId)?.jumpedTo).toBe(1);

    registry.handle('resume', { storeId });
    expect(store.getState().todos.items).toEqual(['a', 'b']);
    expect(registry.list().find((s) => s.id === storeId)?.jumpedTo).toBeNull();

    // New app actions continue from a jumped state and return to live mode.
    registry.handle('jump', { storeId, entryId: 0 });
    store.dispatch(slice.actions.add('c'));
    expect(store.getState().todos.items).toEqual(['c']);
    expect(registry.list().find((s) => s.id === storeId)?.jumpedTo).toBeNull();
    expect(historyTypes(storeId)).not.toContain('@@DEVKIT/SET_STATE');
  });

  it('imports state and records it in the history', () => {
    const slice = makeSlice();
    const store = RTK.configureStore({ reducer: { todos: slice.reducer } });
    const storeId = latestStoreId();

    registry.handle('importState', { storeId, state: { todos: { items: ['imported'], filter: 'x' } } });
    expect(store.getState()).toEqual({ todos: { items: ['imported'], filter: 'x' } });
    expect(historyTypes(storeId)).toEqual(['@@INIT', '@@DEVKIT/IMPORT']);

    store.dispatch(slice.actions.add('next'));
    expect(store.getState().todos.items).toEqual(['imported', 'next']);
  });

  it('dispatches panel actions through middleware', () => {
    const slice = makeSlice();
    const seen: string[] = [];
    const spy: import('redux').Middleware = () => (next) => (action) => {
      seen.push((action as { type: string }).type);
      return next(action);
    };
    const store = RTK.configureStore({
      reducer: { todos: slice.reducer },
      middleware: (getDefault) => getDefault().concat(spy),
    });
    const storeId = latestStoreId();

    registry.handle('dispatch', { storeId, action: { type: 'todos/add', payload: 'from panel' } });
    expect(seen).toEqual(['todos/add']);
    expect(store.getState().todos.items).toEqual(['from panel']);
    expect(() => registry.handle('dispatch', { storeId, action: 'nope' })).toThrow(/type/);
  });

  it('pauses recording and clears history', () => {
    const slice = makeSlice();
    const store = RTK.configureStore({ reducer: { todos: slice.reducer } });
    const storeId = latestStoreId();

    registry.handle('setPaused', { storeId, paused: true });
    store.dispatch(slice.actions.add('ignored'));
    expect(historyTypes(storeId)).toEqual(['@@INIT']);

    registry.handle('setPaused', { storeId, paused: false });
    store.dispatch(slice.actions.add('kept'));
    registry.handle('clearHistory', { storeId });
    expect(historyTypes(storeId)).toEqual(['@@DEVKIT/BASELINE']);
    expect(registry.handle('getEntry', { storeId, entryId: 2, part: 'state' })).toEqual({
      todos: { items: ['ignored', 'kept'], filter: 'all' },
    });
  });

  it('supports the legacy __REDUX_DEVTOOLS_EXTENSION__() enhancer and connect()', () => {
    const reducer = (state = 0, action: { type: string }) => (action.type === 'inc' ? state + 1 : state);
    const store = redux.legacy_createStore(reducer, win.__REDUX_DEVTOOLS_EXTENSION__({ name: 'Legacy' }));
    const storeId = latestStoreId();
    store.dispatch({ type: 'inc' });
    expect(registry.list().find((s) => s.id === storeId)?.name).toBe('Legacy');
    registry.handle('jump', { storeId, entryId: 0 });
    expect(store.getState()).toBe(0);

    const connection = win.__REDUX_DEVTOOLS_EXTENSION__.connect({ name: 'zustand' });
    expect(() => connection.init({})).not.toThrow();
    expect(typeof connection.subscribe(() => {})).toBe('function');
  });
});

describe('coexistence with the real Redux DevTools extension', () => {
  it('chains a compose function assigned after the hook was installed', () => {
    const calls: string[] = [];
    // Mimics Redux DevTools: its instrument enhancer is innermost and lifts the state.
    const instrument = (createStore: any) => (reducer: any, preloaded: any) => {
      const liftedReducer = (lifted: any = { computed: undefined, count: 0 }, action: any) => ({
        computed: reducer(lifted.computed, action),
        count: lifted.count + 1,
      });
      const store = createStore(liftedReducer, preloaded);
      return { ...store, getState: () => store.getState().computed };
    };
    const realCompose = (...args: any[]) => {
      if (typeof args[0] === 'object') {
        calls.push(`config:${args[0].name}`);
        return (...funcs: any[]) => redux.compose(...funcs, instrument);
      }
      return redux.compose(...args, instrument);
    };

    win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = realCompose;
    try {
      const reducer = (state = { n: 0 }, action: { type: string }) => (action.type === 'inc' ? { n: state.n + 1 } : state);
      const store = redux.legacy_createStore(reducer, win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__({ name: 'Both' })(redux.applyMiddleware()));
      const storeId = latestStoreId();

      store.dispatch({ type: 'inc' });
      store.dispatch({ type: 'inc' });
      expect(calls).toEqual(['config:Both']);
      expect(store.getState()).toEqual({ n: 2 });
      expect(registry.handle('getEntry', { storeId, entryId: 2, part: 'state' })).toEqual({ n: 2 });

      registry.handle('jump', { storeId, entryId: 1 });
      expect(store.getState()).toEqual({ n: 1 });
    } finally {
      win.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = undefined;
    }
  });
});
