// Minimal structural Redux types so the page hook does not depend on redux.

export interface AnyAction {
  type: unknown;
  [key: string]: unknown;
}

export type Reducer = (state: unknown, action: AnyAction) => unknown;
export type Dispatch = (action: unknown) => unknown;

export interface ReduxStore {
  getState(): unknown;
  dispatch: Dispatch;
  subscribe(listener: () => void): () => void;
  replaceReducer(next: Reducer): void;
}

export type StoreCreator = (reducer: Reducer, preloadedState?: unknown, enhancer?: unknown) => ReduxStore;
export type StoreEnhancer = (next: StoreCreator) => StoreCreator;

export function isStoreLike(value: unknown): value is ReduxStore {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<ReduxStore>;
  return typeof s.getState === 'function' && typeof s.dispatch === 'function' && typeof s.subscribe === 'function';
}

export function isPlainAction(value: unknown): value is AnyAction {
  return typeof value === 'object' && value !== null && 'type' in value;
}
