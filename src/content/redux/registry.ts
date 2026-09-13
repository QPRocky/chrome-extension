import { diff } from '../../shared/diff';
import {
  SET_STATE,
  type ActionSummary,
  type PageEvent,
  type RequestMap,
  type RequestMethod,
  type SerializedChange,
  type StoreHistory,
  type StoreInfo,
  type StoreMode,
} from '../../shared/messages';
import { revive, serialize } from '../../shared/serialize';
import { isPlainAction, type ReduxStore } from './types';

interface HistoryEntry extends ActionSummary {
  action: unknown;
  prevState: unknown;
  nextState: unknown;
}

export interface StoreRecord {
  id: string;
  name: string;
  mode: StoreMode;
  /** Store with our wrapped reducer; SET_STATE must be dispatched here. */
  inner: ReduxStore;
  /** Outermost store (with middleware), used for dispatches from the panel. */
  outer: ReduxStore | null;
  history: HistoryEntry[];
  pending: ActionSummary[];
  nextEntryId: number;
  paused: boolean;
  jumpedTo: number | null;
}

export interface RegistryOptions {
  emit(event: PageEvent): void;
  /** Finds stores that were not created through the enhancer hook. */
  scan?: () => ReduxStore[];
  maxHistory?: number;
  /** Schedules a flush of batched action events. */
  schedule?: (fn: () => void) => void;
}

type Handlers = {
  [M in RequestMethod]: (params: RequestMap[M]['params']) => RequestMap[M]['result'];
};

const LIMITED_REASON = 'Time travel and import need the enhancer hook';

export class Registry {
  private readonly stores: StoreRecord[] = [];
  private readonly known = new WeakSet<object>();
  private readonly maxHistory: number;
  private attached = false;
  private flushScheduled = false;

  constructor(private readonly options: RegistryOptions) {
    this.maxHistory = options.maxHistory ?? 500;
  }

  get size(): number {
    return this.stores.length;
  }

  list(): StoreInfo[] {
    return this.stores.map(info);
  }

  /** Registers a store created through the enhancer hook. */
  registerHooked(inner: ReduxStore, name?: string): StoreRecord {
    return this.add(inner, 'hooked', name);
  }

  setOuter(record: StoreRecord, outer: ReduxStore): void {
    record.outer = outer;
    this.known.add(outer);
  }

  /** Registers a store found at runtime: its dispatch is patched, time travel is unavailable. */
  registerLimited(store: ReduxStore, name?: string): StoreRecord | null {
    if (this.known.has(store)) return null;
    const record = this.add(store, 'limited', name);
    record.outer = store;

    const registry = this;
    const original = store.dispatch;
    const plainActions: unknown[] = [];
    let lastState = store.getState();

    store.dispatch = function patchedDispatch(this: unknown, action: unknown) {
      if (!isPlainAction(action)) return original.call(this, action);
      const prev = store.getState();
      plainActions.push(action);
      try {
        return original.call(this, action);
      } finally {
        plainActions.pop();
        const next = store.getState();
        lastState = next;
        if (next !== prev) registry.record(record, action, prev, next);
      }
    };

    // Catches changes that bypass store.dispatch, e.g. dispatches made inside thunks.
    store.subscribe(() => {
      const next = store.getState();
      if (next === lastState || plainActions.length > 0) return;
      const prev = lastState;
      lastState = next;
      registry.record(record, undefined, prev, next);
    });

    return record;
  }

  isKnown(store: object): boolean {
    return this.known.has(store);
  }

  record(record: StoreRecord, action: unknown, prevState: unknown, nextState: unknown): void {
    if (record.jumpedTo !== null) {
      record.jumpedTo = null;
      this.emit({ kind: 'store-updated', store: info(record) });
    }
    if (record.paused) return;

    const entry: HistoryEntry = {
      id: record.nextEntryId++,
      type: actionType(action),
      ts: Date.now(),
      action,
      prevState,
      nextState,
    };
    record.history.push(entry);
    if (record.history.length > this.maxHistory) record.history.splice(0, record.history.length - this.maxHistory);

    if (!this.attached) return;
    record.pending.push(summary(entry));
    this.scheduleFlush();
  }

  flush(): void {
    this.flushScheduled = false;
    for (const record of this.stores) {
      if (record.pending.length === 0) continue;
      const entries = record.pending;
      record.pending = [];
      this.emit({ kind: 'actions', storeId: record.id, entries, minId: record.history[0]?.id ?? 0 });
    }
  }

  handle<M extends RequestMethod>(method: M, params: RequestMap[M]['params']): RequestMap[M]['result'] {
    this.attached = true;
    const handler = this.handlers[method] as (p: RequestMap[M]['params']) => RequestMap[M]['result'];
    if (!handler) throw new Error(`Unknown method: ${String(method)}`);
    return handler(params);
  }

  private readonly handlers: Handlers = {
    init: () => {
      if (!this.stores.some((s) => s.mode === 'hooked')) this.scan();
      const histories: Record<string, StoreHistory> = {};
      for (const record of this.stores) {
        record.pending = [];
        histories[record.id] = { entries: record.history.map(summary) };
      }
      return { stores: this.list(), histories };
    },

    detect: () => {
      this.scan();
      return { stores: this.list() };
    },

    getEntry: ({ storeId, entryId, part }) => {
      const record = this.get(storeId);
      const entry = record.history.find((e) => e.id === entryId);
      if (!entry) throw new Error(`Entry #${entryId} is no longer in history`);
      if (part === 'action') return serialize(entry.action);
      if (part === 'state') return serialize(entry.nextState);
      return diff(entry.prevState, entry.nextState).map(
        (c): SerializedChange => ({
          path: c.path,
          kind: c.kind,
          before: c.kind === 'added' ? undefined : serialize(c.before),
          after: c.kind === 'removed' ? undefined : serialize(c.after),
        }),
      );
    },

    getState: ({ storeId }) => serialize(this.get(storeId).inner.getState()),

    dispatch: ({ storeId, action }) => {
      const record = this.get(storeId);
      const revived = revive(action);
      if (!isPlainAction(revived)) throw new Error('Action must be an object with a "type" property');
      (record.outer ?? record.inner).dispatch(revived);
      return null;
    },

    jump: ({ storeId, entryId }) => {
      const record = this.requireHooked(storeId);
      const entry = record.history.find((e) => e.id === entryId);
      if (!entry) throw new Error(`Entry #${entryId} is no longer in history`);
      this.setState(record, entry.nextState);
      const last = record.history[record.history.length - 1];
      record.jumpedTo = entry === last ? null : entry.id;
      this.emit({ kind: 'store-updated', store: info(record) });
      return null;
    },

    resume: ({ storeId }) => {
      const record = this.requireHooked(storeId);
      const last = record.history[record.history.length - 1];
      if (last) this.setState(record, last.nextState);
      record.jumpedTo = null;
      this.emit({ kind: 'store-updated', store: info(record) });
      return null;
    },

    importState: ({ storeId, state }) => {
      const record = this.requireHooked(storeId);
      const prev = record.inner.getState();
      this.setState(record, revive(state));
      record.jumpedTo = null;
      this.record(record, { type: '@@DEVKIT/IMPORT' }, prev, record.inner.getState());
      this.flush();
      return null;
    },

    clearHistory: ({ storeId }) => {
      const record = this.get(storeId);
      record.history = [];
      record.pending = [];
      record.jumpedTo = null;
      const state = record.inner.getState();
      const baseline = this.baseline(record, '@@DEVKIT/BASELINE', state);
      this.emit({ kind: 'history-cleared', storeId, entries: [summary(baseline)] });
      this.emit({ kind: 'store-updated', store: info(record) });
      return null;
    },

    setPaused: ({ storeId, paused }) => {
      const record = this.get(storeId);
      record.paused = paused;
      this.emit({ kind: 'store-updated', store: info(record) });
      return null;
    },
  };

  private add(store: ReduxStore, mode: StoreMode, name?: string): StoreRecord {
    const index = this.stores.length + 1;
    const record: StoreRecord = {
      id: `store-${index}`,
      name: name || (index === 1 ? 'Store' : `Store ${index}`),
      mode,
      inner: store,
      outer: null,
      history: [],
      pending: [],
      nextEntryId: 0,
      paused: false,
      jumpedTo: null,
    };
    this.known.add(store);
    this.stores.push(record);
    this.baseline(record, '@@INIT', store.getState());
    this.emit({ kind: 'store-added', store: info(record) });
    if (this.attached) {
      this.emit({ kind: 'actions', storeId: record.id, entries: record.history.map(summary), minId: 0 });
    }
    return record;
  }

  private baseline(record: StoreRecord, type: string, state: unknown): HistoryEntry {
    const entry: HistoryEntry = {
      id: record.nextEntryId++,
      type,
      ts: Date.now(),
      action: { type },
      prevState: undefined,
      nextState: state,
    };
    record.history.push(entry);
    return entry;
  }

  private scan(): void {
    const found = this.options.scan?.() ?? [];
    for (const store of found) {
      if (!this.known.has(store)) this.registerLimited(store);
    }
  }

  private setState(record: StoreRecord, state: unknown): void {
    record.inner.dispatch({ type: SET_STATE, state });
  }

  private get(storeId: string): StoreRecord {
    const record = this.stores.find((s) => s.id === storeId);
    if (!record) throw new Error(`Unknown store: ${storeId}`);
    return record;
  }

  private requireHooked(storeId: string): StoreRecord {
    const record = this.get(storeId);
    if (record.mode !== 'hooked') throw new Error(`${LIMITED_REASON} (store was found in the React tree)`);
    return record;
  }

  private emit(event: PageEvent): void {
    if (this.attached || event.kind === 'response') this.options.emit(event);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    (this.options.schedule ?? ((fn) => setTimeout(fn, 16)))(() => this.flush());
  }
}

function info(record: StoreRecord): StoreInfo {
  return { id: record.id, name: record.name, mode: record.mode, paused: record.paused, jumpedTo: record.jumpedTo };
}

function summary(entry: HistoryEntry): ActionSummary {
  return { id: entry.id, type: entry.type, ts: entry.ts };
}

function actionType(action: unknown): string {
  if (action === undefined) return '(state changed)';
  if (!isPlainAction(action)) return '(non-object action)';
  return typeof action.type === 'string' ? action.type : String(action.type);
}
