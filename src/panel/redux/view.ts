import { formatPath } from '../../shared/diff';
import type { ActionSummary, EntryPart, RequestMap, SerializedChange, StoreInfo } from '../../shared/messages';
import { isMarker } from '../../shared/serialize';
import { button, copyWithToast, downloadFile, h, pickFile, safeFilePart, timestampForFile, toast } from '../ui/dom';
import { createSplit } from '../ui/split';
import { inlinePreview, isExpandable, renderTree } from '../ui/tree';
import { PageUnavailableError, type ReduxClient } from './client';

const DRAFT_KEY = 'redux.dispatchDraft';
const CACHE_LIMIT = 60;
const LIMITED_HINT =
  'This store was found in the React tree, so the app\'s reducer is not reachable: time travel and import are disabled. ' +
  'Create the store with Redux DevTools support (e.g. RTK configureStore with devTools enabled) to unlock them.';

export interface NavigationSource {
  onNavigated(listener: () => void): void;
}

export function createReduxView(root: HTMLElement, client: ReduxClient, navigation: NavigationSource): void {
  const stores = new Map<string, StoreInfo>();
  const histories = new Map<string, ActionSummary[]>();
  const cache = new Map<string, unknown>();
  let storeId: string | null = null;
  let selectedId: number | null = null;
  let followLatest = true;
  let tab: EntryPart = 'state';
  let query = '';
  let typeFilter = '';
  let initToken = 0;
  let contentToken = 0;
  let listFrame = 0;
  let contentTimer: ReturnType<typeof setTimeout> | undefined;

  // ── toolbar ────────────────────────────────────────────────────────────
  const storeSelect = h('select', { title: 'Store' });
  storeSelect.addEventListener('change', () => selectStore(storeSelect.value));
  const badge = h('span', { class: 'badge' });
  const pauseBtn = button('Pause', () => current() && request('setPaused', { storeId: current()!.id, paused: !current()!.paused }), { title: 'Pause or resume recording actions' });
  const clearBtn = button('Clear', () => current() && request('clearHistory', { storeId: current()!.id }), { title: 'Clear the action log' });
  const exportBtn = button('Export state', () => void exportState(), { title: 'Save the selected state as JSON' });
  const importBtn = button('Import state', () => void importState(), { title: 'Replace the store state from a JSON file' });
  const dispatchBtn = button('Dispatch…', () => toggleDispatch(), { title: 'Dispatch an action' });
  const scanBtn = button('Scan React tree', () => void scan(), { title: 'Look for stores passed to react-redux <Provider>' });
  const statusText = h('span', { class: 'muted status' });
  const toolbar = h('div', { class: 'toolbar' }, storeSelect, badge, pauseBtn, clearBtn, h('span', { class: 'sep' }), exportBtn, importBtn, dispatchBtn, scanBtn, h('span', { class: 'spacer' }), statusText);

  const banner = h('div', { class: 'banner', hidden: true });

  // ── action list ────────────────────────────────────────────────────────
  const typeInput = h('input', { type: 'search', class: 'filter', placeholder: 'Filter actions' });
  typeInput.addEventListener('input', () => {
    typeFilter = typeInput.value.trim().toLowerCase();
    renderList();
  });
  const actionList = h('ul', { class: 'actions', tabIndex: 0 });
  actionList.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const visible = visibleEntries();
    const index = visible.findIndex((e) => e.id === selectedId);
    const next = visible[event.key === 'ArrowDown' ? index + 1 : Math.max(0, index - 1)];
    if (next) selectEntry(next.id);
  });
  const listEmpty = h('div', { class: 'empty' });
  const left = h('div', { class: 'column' }, h('div', { class: 'subbar' }, typeInput), h('div', { class: 'scroll' }, actionList, listEmpty));

  // ── detail ─────────────────────────────────────────────────────────────
  const tabButtons = new Map<EntryPart, HTMLButtonElement>();
  const tabs = h(
    'div',
    { class: 'tabs' },
    ...(['action', 'state', 'diff'] as EntryPart[]).map((id) => {
      const btn = h('button', { type: 'button', class: 'tab', onClick: () => ((tab = id), renderTabs(), renderContent()) }, id[0].toUpperCase() + id.slice(1));
      tabButtons.set(id, btn);
      return btn;
    }),
  );
  const searchInput = h('input', { type: 'search', class: 'filter', placeholder: 'Search keys and values' });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value;
      renderContent();
    }, 150);
  });
  const matchInfo = h('span', { class: 'muted' });
  const entryTitle = h('span', { class: 'entry-title' });
  const content = h('div', { class: 'scroll pad' });
  const right = h('div', { class: 'column' }, h('div', { class: 'subbar' }, tabs, entryTitle, h('span', { class: 'spacer' }), searchInput, matchInfo), content);

  // ── dispatch drawer ────────────────────────────────────────────────────
  const dispatchArea = h('textarea', { class: 'code-input', spellcheck: 'false', rows: 5, placeholder: '{ "type": "todos/add", "payload": "Hello" }   or just   todos/clear' });
  dispatchArea.value = readDraft();
  dispatchArea.addEventListener('input', () => writeDraft(dispatchArea.value));
  dispatchArea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void dispatchAction();
    }
  });
  const dispatchError = h('span', { class: 'error-text' });
  const drawer = h(
    'div',
    { class: 'drawer', hidden: true },
    dispatchArea,
    h('div', { class: 'subbar' }, button('Dispatch', () => void dispatchAction(), { class: 'btn primary' }), h('span', { class: 'muted' }, 'JSON action object or an action type · ⌘/Ctrl+Enter'), dispatchError, h('span', { class: 'spacer' }), button('Close', () => toggleDispatch(false))),
  );

  root.append(toolbar, banner, h('div', { class: 'view-body' }, createSplit(left, right, { initial: 35, storageKey: 'redux.split' })), drawer);
  renderAll();

  // ── wiring ─────────────────────────────────────────────────────────────
  client.onEvent((event) => {
    switch (event.kind) {
      case 'store-added':
        stores.set(event.store.id, event.store);
        if (!histories.has(event.store.id)) histories.set(event.store.id, []);
        if (!storeId) selectStore(event.store.id);
        renderToolbar();
        setStatus('');
        break;
      case 'store-updated':
        stores.set(event.store.id, event.store);
        if (event.store.id === storeId && event.store.jumpedTo !== null) {
          followLatest = false;
          selectedId = event.store.jumpedTo;
          scheduleContent();
        }
        renderToolbar();
        scheduleList();
        break;
      case 'actions': {
        const history = histories.get(event.storeId) ?? [];
        const lastId = history.length ? history[history.length - 1].id : -1;
        for (const entry of event.entries) if (entry.id > lastId) history.push(entry);
        const firstKept = history.findIndex((e) => e.id >= event.minId);
        if (firstKept > 0) history.splice(0, firstKept);
        histories.set(event.storeId, history);
        if (event.storeId === storeId) {
          if (followLatest && history.length) selectedId = history[history.length - 1].id;
          scheduleList();
          if (followLatest) scheduleContent();
        }
        break;
      }
      case 'history-cleared':
        histories.set(event.storeId, [...event.entries]);
        dropCache(event.storeId);
        if (event.storeId === storeId) {
          followLatest = true;
          selectedId = event.entries[event.entries.length - 1]?.id ?? null;
          renderList();
          renderContent();
        }
        break;
    }
  });

  client.onReconnect(() => void init());
  navigation.onNavigated(() => void init());
  void init();

  // ── actions ────────────────────────────────────────────────────────────
  async function init(): Promise<void> {
    const token = ++initToken;
    stores.clear();
    histories.clear();
    cache.clear();
    storeId = null;
    selectedId = null;
    followLatest = true;
    renderAll();
    setStatus('Connecting to page…');

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = await client.request('init', undefined);
        if (token !== initToken) return;
        applyInit(result);
        return;
      } catch (err) {
        if (token !== initToken) return;
        if (!(err instanceof PageUnavailableError)) {
          setStatus(message(err));
          return;
        }
        await delay(300 + attempt * 200);
        if (token !== initToken) return;
      }
    }
    setStatus('Page is not reachable. Reload the page if the extension was installed or updated after it was opened.');
  }

  function applyInit(result: RequestMap['init']['result']) {
    for (const store of result.stores) {
      stores.set(store.id, store);
      histories.set(store.id, result.histories[store.id]?.entries ?? []);
    }
    const first = result.stores[0];
    if (first) selectStore(first.id);
    else renderAll();
    setStatus('');
  }

  function selectStore(id: string) {
    storeId = id;
    const history = histories.get(id) ?? [];
    const info = stores.get(id);
    followLatest = info?.jumpedTo == null;
    selectedId = info?.jumpedTo ?? history[history.length - 1]?.id ?? null;
    renderAll();
  }

  function selectEntry(id: number) {
    const history = histories.get(storeId ?? '') ?? [];
    selectedId = id;
    followLatest = history[history.length - 1]?.id === id && current()?.jumpedTo == null;
    renderList();
    renderContent();
  }

  async function request<M extends keyof RequestMap>(method: M, params: RequestMap[M]['params']): Promise<RequestMap[M]['result'] | undefined> {
    try {
      return await client.request(method, params);
    } catch (err) {
      toast(message(err), 'error');
      return undefined;
    }
  }

  async function jump(entryId: number) {
    const store = current();
    if (!store) return;
    await request('jump', { storeId: store.id, entryId });
  }

  async function resume() {
    const store = current();
    if (!store) return;
    await request('resume', { storeId: store.id });
    followLatest = true;
    const history = histories.get(store.id) ?? [];
    selectedId = history[history.length - 1]?.id ?? null;
    renderList();
    renderContent();
  }

  async function exportState() {
    const store = current();
    if (!store) return toast('No store selected', 'error');
    const state =
      followLatest || selectedId === null
        ? await request('getState', { storeId: store.id })
        : await getPart(store.id, selectedId, 'state').catch((err) => void toast(message(err), 'error'));
    if (state === undefined) return;
    const suffix = followLatest || selectedId === null ? 'current' : `entry-${selectedId}`;
    downloadFile(`redux-${safeFilePart(store.name)}-${suffix}-${timestampForFile()}.json`, JSON.stringify(state, null, 2));
    toast('State exported');
  }

  async function importState() {
    const store = current();
    if (!store) return toast('No store selected', 'error');
    if (store.mode !== 'hooked') return toast(LIMITED_HINT, 'error');
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let state: unknown;
    try {
      state = JSON.parse(await file.text());
    } catch (err) {
      return toast(`Invalid JSON: ${message(err)}`, 'error');
    }
    followLatest = true;
    const ok = await request('importState', { storeId: store.id, state });
    if (ok !== undefined) toast(`Imported ${file.name}`);
  }

  async function dispatchAction() {
    const store = current();
    if (!store) return toast('No store selected', 'error');
    const text = dispatchArea.value.trim();
    dispatchError.textContent = '';
    if (!text) return;
    let action: unknown;
    if (text.startsWith('{')) {
      try {
        action = JSON.parse(text);
      } catch (err) {
        dispatchError.textContent = `Invalid JSON: ${message(err)}`;
        return;
      }
    } else {
      action = { type: text };
    }
    try {
      await client.request('dispatch', { storeId: store.id, action });
      toast('Action dispatched');
    } catch (err) {
      dispatchError.textContent = message(err);
    }
  }

  async function scan() {
    const result = await request('detect', undefined);
    if (!result) return;
    for (const store of result.stores) {
      stores.set(store.id, store);
      if (!histories.has(store.id)) histories.set(store.id, []);
    }
    if (!storeId && result.stores[0]) selectStore(result.stores[0].id);
    renderToolbar();
    toast(result.stores.length ? `${result.stores.length} store(s) available` : 'No Redux store found in the React tree', result.stores.length ? 'info' : 'error');
  }

  function toggleDispatch(force?: boolean) {
    drawer.hidden = force === undefined ? !drawer.hidden : !force;
    if (!drawer.hidden) dispatchArea.focus();
  }

  // ── data ───────────────────────────────────────────────────────────────
  function setStatus(text: string) {
    statusText.textContent = text;
    statusText.title = text;
  }

  function current(): StoreInfo | undefined {
    return storeId ? stores.get(storeId) : undefined;
  }

  function visibleEntries(): ActionSummary[] {
    const history = histories.get(storeId ?? '') ?? [];
    return typeFilter ? history.filter((e) => e.type.toLowerCase().includes(typeFilter)) : history;
  }

  async function getPart(sId: string, entryId: number, part: EntryPart): Promise<unknown> {
    const key = `${sId}:${entryId}:${part}`;
    if (cache.has(key)) return cache.get(key);
    const value = await client.request('getEntry', { storeId: sId, entryId, part });
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return value;
  }

  function dropCache(sId: string) {
    for (const key of [...cache.keys()]) if (key.startsWith(`${sId}:`)) cache.delete(key);
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function renderAll() {
    renderToolbar();
    renderTabs();
    renderList();
    renderContent();
  }

  function renderToolbar() {
    const store = current();
    storeSelect.replaceChildren(...[...stores.values()].map((s) => h('option', { value: s.id }, s.name)));
    storeSelect.hidden = stores.size < 2;
    if (store) storeSelect.value = store.id;

    badge.hidden = !store;
    if (store) {
      badge.textContent = stores.size < 2 ? `${store.name} · ${store.mode}` : store.mode;
      badge.className = `badge ${store.mode}`;
      badge.title = store.mode === 'limited' ? LIMITED_HINT : 'Store created with the enhancer hook: all features available';
    }
    const hasStore = Boolean(store);
    const hooked = store?.mode === 'hooked';
    pauseBtn.disabled = !hasStore;
    pauseBtn.textContent = store?.paused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('active', Boolean(store?.paused));
    clearBtn.disabled = !hasStore;
    exportBtn.disabled = !hasStore;
    importBtn.disabled = !hooked;
    importBtn.title = hooked ? 'Replace the store state from a JSON file' : LIMITED_HINT;
    dispatchBtn.disabled = !hasStore;

    banner.hidden = !store || store.jumpedTo === null;
    if (store && store.jumpedTo !== null) {
      const entry = histories.get(store.id)?.find((e) => e.id === store.jumpedTo);
      banner.replaceChildren(
        h('span', null, `The app is showing the state after #${store.jumpedTo} ${entry?.type ?? ''}. New actions will continue from this state.`),
        button('Resume live', () => void resume(), { class: 'btn primary small' }),
      );
    }
  }

  function renderTabs() {
    for (const [id, btn] of tabButtons) btn.classList.toggle('active', id === tab);
    searchInput.hidden = tab === 'diff';
    matchInfo.hidden = tab === 'diff';
  }

  function scheduleList() {
    if (listFrame) return;
    listFrame = requestAnimationFrame(() => {
      listFrame = 0;
      renderList();
    });
  }

  function renderList() {
    const store = current();
    const visible = visibleEntries();
    const scroller = actionList.parentElement!;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;

    actionList.replaceChildren(
      ...visible.map((entry) => {
        const classes = ['action'];
        if (entry.id === selectedId) classes.push('selected');
        if (store?.jumpedTo === entry.id) classes.push('jumped');
        if (entry.type.startsWith('@@')) classes.push('internal');
        const li = h(
          'li',
          { class: classes.join(' '), title: entry.type },
          h('span', { class: 'id' }, `#${entry.id}`),
          h('span', { class: 'type' }, entry.type),
          h('span', { class: 'time' }, formatTime(entry.ts)),
          store?.mode === 'hooked'
            ? h('button', { type: 'button', class: 'mini', title: 'Set the app state to the state after this action', onClick: (e: MouseEvent) => (e.stopPropagation(), void jump(entry.id)) }, 'jump')
            : null,
        );
        li.addEventListener('click', () => selectEntry(entry.id));
        return li;
      }),
    );

    if (!store) {
      listEmpty.hidden = false;
      listEmpty.replaceChildren(
        h('p', null, 'No Redux store detected yet.'),
        h('p', { class: 'muted' }, 'Stores created with Redux DevTools support (RTK configureStore, composeWithDevTools) are hooked automatically when the page loads. Stores passed to react-redux <Provider> can be found with "Scan React tree".'),
      );
    } else {
      listEmpty.hidden = visible.length > 0;
      listEmpty.textContent = typeFilter ? 'No matching actions.' : 'No actions recorded.';
    }

    if (followLatest && atBottom) scroller.scrollTop = scroller.scrollHeight;
    else if (selectedId !== null) actionList.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function scheduleContent() {
    clearTimeout(contentTimer);
    contentTimer = setTimeout(renderContent, 40);
  }

  async function renderContent() {
    const token = ++contentToken;
    const store = current();
    matchInfo.textContent = '';
    const entry = histories.get(storeId ?? '')?.find((e) => e.id === selectedId);
    entryTitle.textContent = entry ? `#${entry.id} ${entry.type}` : '';

    if (!store || selectedId === null || !entry) {
      content.replaceChildren(h('div', { class: 'empty' }, store ? 'Select an action.' : ''));
      return;
    }

    content.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    let value: unknown;
    try {
      value = await getPart(store.id, entry.id, tab);
    } catch (err) {
      if (token === contentToken) content.replaceChildren(h('div', { class: 'empty error-text' }, message(err)));
      return;
    }
    if (token !== contentToken) return;

    if (tab === 'diff') {
      content.replaceChildren(renderDiff(value as SerializedChange[]));
      return;
    }
    const filter = tab === 'state';
    const tree = renderTree(value, { expandDepth: tab === 'action' ? 3 : 1, query, filter, rootPath: [] });
    const searching = query.trim() !== '';
    matchInfo.textContent = searching ? `${tree.matches} matches${tree.truncated ? ' (search limit reached)' : ''}` : '';
    const copyBtn = button('Copy JSON', () => copyWithToast(JSON.stringify(value, null, 2), 'Copied'), { class: 'btn small' });
    const body = filter && searching && tree.matches === 0 && !tree.truncated ? h('div', { class: 'empty' }, 'No matching keys or values.') : tree.element;
    content.replaceChildren(h('div', { class: 'content-actions' }, copyBtn), body);
  }
}

function renderDiff(changes: SerializedChange[]): HTMLElement {
  if (changes.length === 0) return h('div', { class: 'empty' }, 'This action did not change the state.');
  return h(
    'div',
    { class: 'diff' },
    ...changes.map((change) => {
      const path = formatPath(change.path) || '(root)';
      return h(
        'div',
        { class: `diff-row ${change.kind}` },
        h(
          'div',
          { class: 'diff-head' },
          h('span', { class: `diff-kind ${change.kind}` }, change.kind),
          h('code', { class: 'diff-path', title: 'Click to copy path', onClick: () => copyWithToast(formatPath(change.path), 'Path copied') }, path),
        ),
        h(
          'div',
          { class: 'diff-values' },
          change.kind !== 'added' ? diffValue(change.before, 'before') : null,
          change.kind === 'changed' ? h('span', { class: 'arrow' }, '→') : null,
          change.kind !== 'removed' ? diffValue(change.after, 'after') : null,
        ),
      );
    }),
  );
}

function diffValue(value: unknown, cls: string): HTMLElement {
  if (!isExpandable(value) || (isMarker(value) && value.$devkit !== 'Map' && value.$devkit !== 'Set' && value.$devkit !== 'object')) {
    return h('span', { class: `diff-value ${cls}` }, inlinePreview(value, 300));
  }
  return h('div', { class: `diff-value ${cls} block` }, renderTree(value, { expandDepth: 1 }).element);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(value: string): void {
  try {
    localStorage.setItem(DRAFT_KEY, value);
  } catch {
    // storage unavailable
  }
}

