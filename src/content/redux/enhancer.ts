import { SET_STATE } from '../../shared/messages';
import type { Registry, StoreRecord } from './registry';
import type { AnyAction, Reducer, ReduxStore, StoreCreator, StoreEnhancer } from './types';

const COMPOSE_KEY = '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__';
const EXTENSION_KEY = '__REDUX_DEVTOOLS_EXTENSION__';

type AnyFn = (...args: any[]) => any;
type DevtoolsConfig = { name?: string } & Record<string, unknown>;

function compose(...fns: AnyFn[]): AnyFn {
  if (fns.length === 0) return (arg: unknown) => arg;
  return fns.reduce(
    (a, b) =>
      (...args: unknown[]) =>
        a(b(...args)),
  );
}

function liftReducer(reducer: Reducer): Reducer {
  return (state, action) => (action && action.type === SET_STATE ? action.state : reducer(state, action));
}

/**
 * Enhancer that records every action reaching the reducer and lets the panel
 * replace the state. It must be the innermost user enhancer so it sees plain
 * actions after middleware has run.
 */
export function createDevkitEnhancer(registry: Registry, name: string | undefined, onCreate: (record: StoreRecord) => void): StoreEnhancer {
  return (createStore: StoreCreator) => (reducer, preloadedState) => {
    const store = createStore(liftReducer(reducer), preloadedState);

    const dispatch = (action: unknown) => {
      if ((action as AnyAction | null)?.type === SET_STATE) return store.dispatch(action);
      const prev = store.getState();
      const result = store.dispatch(action);
      registry.record(record, action, prev, store.getState());
      return result;
    };

    const enhanced: ReduxStore = {
      ...store,
      dispatch,
      replaceReducer: (next: Reducer) => store.replaceReducer(liftReducer(next)),
    };
    const record = registry.registerHooked(enhanced, name);
    onCreate(record);
    return enhanced;
  };
}

/**
 * Installs `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` and `__REDUX_DEVTOOLS_EXTENSION__`
 * on the page. If the real Redux DevTools extension defines them (before or
 * after us), its implementation is chained so both tools keep working.
 */
export function installReduxGlobals(target: Record<string, any>, registry: Registry): void {
  let realCompose: AnyFn | undefined = typeof target[COMPOSE_KEY] === 'function' ? target[COMPOSE_KEY] : undefined;
  let realExtension: AnyFn | undefined = typeof target[EXTENSION_KEY] === 'function' ? target[EXTENSION_KEY] : undefined;

  const withOuterStore = (config: DevtoolsConfig | undefined, buildEnhancer: (ours: StoreEnhancer) => AnyFn): StoreEnhancer => {
    return (createStore) => (reducer, preloadedState) => {
      let record: StoreRecord | undefined;
      const ours = createDevkitEnhancer(registry, config?.name, (r) => (record = r));
      const outer = buildEnhancer(ours)(createStore)(reducer, preloadedState) as ReduxStore;
      if (record) registry.setOuter(record, outer);
      return outer;
    };
  };

  const composeShim = (...args: unknown[]): unknown => {
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      const config = args[0] as DevtoolsConfig;
      return (...funcs: AnyFn[]) => composeWith(config, funcs);
    }
    return composeWith(undefined, args as AnyFn[]);
  };

  const composeWith = (config: DevtoolsConfig | undefined, funcs: AnyFn[]): StoreEnhancer =>
    withOuterStore(config, (ours) => {
      if (!realCompose) return compose(...funcs, ours);
      const composer = config ? realCompose(config) : realCompose;
      return composer(...funcs, ours);
    });

  const extensionShim = Object.assign(
    (config?: DevtoolsConfig): StoreEnhancer =>
      withOuterStore(config, (ours) => (realExtension ? compose(ours, realExtension(config)) : ours)),
    {
      connect: (...args: unknown[]) => (realExtension as any)?.connect?.(...args) ?? noopConnection(),
      disconnect: (...args: unknown[]) => (realExtension as any)?.disconnect?.(...args),
      send: (...args: unknown[]) => (realExtension as any)?.send?.(...args),
      listen: (...args: unknown[]) => (realExtension as any)?.listen?.(...args),
      open: (...args: unknown[]) => (realExtension as any)?.open?.(...args),
      notifyErrors: (...args: unknown[]) => (realExtension as any)?.notifyErrors?.(...args),
    },
  );

  Object.defineProperty(target, COMPOSE_KEY, {
    configurable: true,
    enumerable: true,
    get: () => composeShim,
    set: (value: unknown) => {
      realCompose = typeof value === 'function' ? (value as AnyFn) : undefined;
    },
  });
  Object.defineProperty(target, EXTENSION_KEY, {
    configurable: true,
    enumerable: true,
    get: () => extensionShim,
    set: (value: unknown) => {
      realExtension = typeof value === 'function' ? (value as AnyFn) : undefined;
    },
  });
}

function noopConnection() {
  return {
    init() {},
    send() {},
    subscribe() {
      return () => {};
    },
    unsubscribe() {},
    error() {},
  };
}
