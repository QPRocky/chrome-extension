import type { Header, QueryString } from 'har-format';
import {
  append,
  button,
  checkbox,
  copyWithToast,
  downloadFile,
  formatBytes,
  formatMs,
  h,
  select,
  timestampForFile,
  toast,
  type Child,
} from '../ui/dom';
import { createSplit } from '../ui/split';
import { renderTree } from '../ui/tree';
import { toCurl, toFetch } from './curl';
import { compileFilter, emptyFilter, highlightTerm, resourceCategory, responseError, statusCategory, type NetFilter, type StatusFilter, type TypeFilter } from './filter';
import { buildHar, buildSimpleJson, entryUrlName, isJsonMime, maybeParseJson, suggestedName } from './har';
import type { NetEntry, NetEvent, NetworkStore } from './store';

type DetailTab = 'headers' | 'payload' | 'response' | 'timing';

const FILTER_KEY = 'network.filter';
const MAX_TEXT_DISPLAY = 2 * 1024 * 1024;

export interface NetworkView {
  attach(store: NetworkStore): void;
}

export function createNetworkView(root: HTMLElement): NetworkView {
  let store: NetworkStore | null = null;
  let unsubscribe: (() => void) | null = null;
  let filter: NetFilter = loadFilter();
  let compiled = compileFilter(filter);
  let selectedId: number | null = null;
  let detailTab: DetailTab = 'headers';
  let includeBodies = true;
  let responseMode: 'tree' | 'raw' = 'tree';
  let responseQuery = '';
  const rows = new Map<number, HTMLTableRowElement>();

  // ── toolbar ────────────────────────────────────────────────────────────
  const recordBtn = button('', () => store?.updateSettings({ recording: !store.settings.recording }), {
    title: 'Start or pause recording',
  });
  const clearBtn = button('Clear', () => store?.clear(), { title: 'Clear recorded requests' });
  const preserveBox = checkbox('Preserve log', false, (checked) => store?.updateSettings({ preserveLog: checked }), 'Keep requests across page navigations');
  const captureBox = checkbox(
    'Full capture',
    false,
    (checked) => {
      store?.updateSettings({ fullCapture: checked });
      if (checked) toast('Full capture is on. Reload the page to capture everything.');
    },
    "Record with chrome.debugger. Chrome hides requests whose call stack includes other extensions' scripts (e.g. Redux DevTools) from DevTools extensions.",
  );

  const filterInput = h('input', { type: 'search', class: 'filter', placeholder: 'Filter URL  (-exclude, /regex/)', value: filter.text });
  filterInput.addEventListener('input', () => updateFilter({ text: filterInput.value }));

  const bodyInput = h('input', { type: 'search', class: 'filter', placeholder: 'Search responses  (-exclude, /regex/)', value: filter.body });
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  bodyInput.addEventListener('input', () => {
    clearTimeout(bodyTimer);
    bodyTimer = setTimeout(() => updateFilter({ body: bodyInput.value }), 150);
  });

  const methodSelect = select(
    [['', 'All methods'], ['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH'], ['DELETE', 'DELETE'], ['OPTIONS', 'OPTIONS']],
    filter.method,
    (method) => updateFilter({ method }),
  );
  const typeSelect = select<TypeFilter>(
    [['all', 'All types'], ['fetch', 'Fetch/XHR'], ['doc', 'Doc'], ['js', 'JS'], ['css', 'CSS'], ['img', 'Img'], ['media', 'Media'], ['ws', 'WS'], ['other', 'Other']],
    filter.type,
    (type) => updateFilter({ type }),
  );
  const statusSelect = select<StatusFilter>(
    [['all', 'All statuses'], ['2xx', '2xx'], ['3xx', '3xx'], ['4xx', '4xx'], ['5xx', '5xx'], ['failed', 'Failed']],
    filter.status,
    (status) => updateFilter({ status }),
  );

  const bodiesBox = checkbox('Bodies', includeBodies, (checked) => (includeBodies = checked), 'Include request and response bodies in exports');
  const limitInput = h('input', { type: 'number', class: 'narrow', min: '1', max: '200', title: 'Maximum response body size to keep (MB)' });
  limitInput.addEventListener('change', () => {
    const value = Number(limitInput.value);
    if (value >= 1) store?.updateSettings({ maxBodyMB: value });
  });

  const count = h('span', { class: 'count' });
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    recordBtn,
    clearBtn,
    preserveBox,
    captureBox,
    h('span', { class: 'sep' }),
    filterInput,
    bodyInput,
    methodSelect,
    typeSelect,
    statusSelect,
    h('span', { class: 'sep' }),
    button('Export HAR', () => exportFile('har'), { title: 'Save visible requests as a HAR file' }),
    button('Export JSON', () => exportFile('json'), { title: 'Save visible requests as simplified JSON' }),
    bodiesBox,
    h('label', { class: 'check', title: 'Maximum response body size to keep (MB)' }, 'Limit', limitInput, 'MB'),
    h('span', { class: 'spacer' }),
    count,
  );

  // ── list ───────────────────────────────────────────────────────────────
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'grid' },
    h('thead', null, h('tr', null, h('th', { class: 'c-method' }, 'Method'), h('th', null, 'Name'), h('th', { class: 'c-status' }, 'Status'), h('th', { class: 'c-type' }, 'Type'), h('th', { class: 'c-num' }, 'Size'), h('th', { class: 'c-num' }, 'Time'))),
    tbody,
  );
  const listEmpty = h('div', { class: 'empty' }, 'Waiting for DevTools…');
  const list = h('div', { class: 'list', tabIndex: 0 }, table, listEmpty);
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const visible = visibleEntries();
    const index = visible.findIndex((e) => e.id === selectedId);
    const next = visible[event.key === 'ArrowDown' ? index + 1 : Math.max(0, index - 1)];
    if (next) selectEntry(next.id, true);
  });

  const detail = h('div', { class: 'detail' });
  const body = h('div', { class: 'view-body' }, createSplit(list, detail, { initial: 55, storageKey: 'network.split' }));
  root.append(toolbar, body);
  renderDetail();

  // ── behaviour ──────────────────────────────────────────────────────────
  function updateFilter(patch: Partial<NetFilter>) {
    filter = { ...filter, ...patch };
    compiled = compileFilter(filter);
    filterInput.classList.toggle('invalid', Boolean(compiled.error));
    filterInput.title = compiled.error ?? '';
    bodyInput.classList.toggle('invalid', Boolean(compiled.bodyError));
    bodyInput.title = compiled.bodyError ?? '';
    saveFilter(filter);
    rebuildList();
  }

  function visibleEntries(): NetEntry[] {
    return store ? store.entries.filter((e) => compiled.test(e)) : [];
  }

  function rebuildList() {
    const visible = visibleEntries();
    tbody.replaceChildren(...visible.map(rowFor));
    updateCount();
  }

  function updateCount() {
    const total = store?.entries.length ?? 0;
    const shown = tbody.childElementCount;
    count.textContent = shown === total ? `${total} requests` : `${shown} / ${total} requests`;
    const noFetch = total > 0 && shown === 0 && filter.type === 'fetch' && store?.settings.fullCapture === false;
    listEmpty.hidden = total > 0 && !noFetch;
    if (!store) return;
    if (noFetch) listEmpty.textContent = "No Fetch/XHR requests. Chrome hides requests started through other extensions' scripts (e.g. Redux DevTools); turn on Full capture to see them.";
    else listEmpty.textContent = store.settings.recording ? 'Recording network activity… Reload the page to capture everything.' : 'Recording is paused.';
  }

  function rowFor(entry: NetEntry): HTMLTableRowElement {
    let row = rows.get(entry.id);
    if (row) return row;
    const { har } = entry;
    const status = statusCategory(har);
    let host = '';
    let path = har.request.url;
    try {
      const url = new URL(har.request.url);
      host = url.host;
      path = url.pathname + url.search;
    } catch {
      // not a URL
    }
    row = h(
      'tr',
      { class: entry.id === selectedId ? 'selected' : '', title: har.request.url },
      h('td', { class: 'c-method' }, har.request.method),
      h('td', { class: 'c-name' }, h('span', { class: 'name' }, entryUrlName(har)), h('span', { class: 'sub' }, host + path)),
      h('td', { class: `c-status s-${status}` }, responseError(har) ?? String(har.response.status || '(failed)')),
      h('td', { class: 'c-type' }, har._resourceType ?? resourceCategory(har)),
      h('td', { class: 'c-num' }, formatBytes(har.response._transferSize ?? har.response.bodySize)),
      h('td', { class: 'c-num' }, formatMs(har.time)),
    );
    row.addEventListener('click', () => selectEntry(entry.id));
    rows.set(entry.id, row);
    return row;
  }

  function selectEntry(id: number | null, scroll = false) {
    if (selectedId !== null) rows.get(selectedId)?.classList.remove('selected');
    selectedId = id;
    responseQuery = highlightTerm(filter.body);
    if (id !== null) {
      const row = rows.get(id);
      row?.classList.add('selected');
      if (scroll) row?.scrollIntoView({ block: 'nearest' });
    }
    renderDetail();
  }

  function onStoreEvent(event: NetEvent) {
    switch (event.type) {
      case 'added': {
        if (!compiled.test(event.entry)) break;
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
        tbody.appendChild(rowFor(event.entry));
        if (atBottom) list.scrollTop = list.scrollHeight;
        break;
      }
      case 'updated':
        if (compiled.searchesBody) syncRow(event.entry);
        if (event.entry.id === selectedId && (detailTab === 'response' || detailTab === 'headers')) renderDetail();
        break;
      case 'removed':
        for (const id of event.ids) {
          rows.get(id)?.remove();
          rows.delete(id);
        }
        if (selectedId !== null && event.ids.includes(selectedId)) selectEntry(null);
        break;
      case 'cleared':
        rows.clear();
        tbody.replaceChildren();
        selectEntry(null);
        break;
      case 'settings':
        renderSettings();
        break;
    }
    updateCount();
  }

  /** Shows or hides a row whose body loaded after it was added, keeping list order. */
  function syncRow(entry: NetEntry) {
    const shown = rows.get(entry.id)?.isConnected ?? false;
    if (!compiled.test(entry)) {
      if (shown) rows.get(entry.id)!.remove();
      return;
    }
    if (shown || !store) return;
    const index = store.entries.indexOf(entry);
    if (index === -1) return;
    const row = rowFor(entry);
    for (let i = index + 1; i < store.entries.length; i++) {
      const next = rows.get(store.entries[i].id);
      if (next?.isConnected) {
        tbody.insertBefore(row, next);
        return;
      }
    }
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
    tbody.appendChild(row);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function renderSettings() {
    if (!store) return;
    const { recording, preserveLog, maxBodyMB, fullCapture } = store.settings;
    recordBtn.textContent = recording ? '● Recording' : '○ Paused';
    recordBtn.classList.toggle('recording', recording);
    (preserveBox.querySelector('input') as HTMLInputElement).checked = preserveLog;
    (captureBox.querySelector('input') as HTMLInputElement).checked = fullCapture;
    limitInput.value = String(maxBodyMB);
    const captureError = store.takeCaptureError();
    if (captureError) toast(captureError, 'error');
  }

  function exportFile(kind: 'har' | 'json') {
    const entries = visibleEntries();
    if (entries.length === 0) {
      toast('Nothing to export', 'error');
      return;
    }
    const options = { includeBodies, creatorVersion: chrome.runtime.getManifest().version };
    const data = kind === 'har' ? buildHar(entries, options) : buildSimpleJson(entries, options);
    downloadFile(suggestedName(entries, kind, timestampForFile()), JSON.stringify(data, null, 2));
    const pending = includeBodies ? entries.filter((e) => e.contentState === 'pending').length : 0;
    toast(`Exported ${entries.length} requests${pending ? ` (${pending} bodies still loading)` : ''}`);
  }

  // ── detail pane ────────────────────────────────────────────────────────
  function renderDetail() {
    const entry = selectedId !== null ? store?.get(selectedId) : undefined;
    if (!entry) {
      detail.replaceChildren(h('div', { class: 'empty' }, 'Select a request to see details.'));
      return;
    }
    const { har } = entry;
    const tabs: [DetailTab, string][] = [
      ['headers', 'Headers'],
      ['payload', 'Payload'],
      ['response', 'Response'],
      ['timing', 'Timing'],
    ];
    const header = h(
      'div',
      { class: 'detail-head' },
      h('div', { class: 'tabs' }, ...tabs.map(([id, label]) => h('button', { type: 'button', class: `tab${id === detailTab ? ' active' : ''}`, onClick: () => ((detailTab = id), renderDetail()) }, label))),
      h('span', { class: 'spacer' }),
      button('URL', () => copyWithToast(har.request.url, 'URL copied'), { class: 'btn small', title: 'Copy URL' }),
      button('cURL', () => copyWithToast(toCurl(har), 'cURL command copied'), { class: 'btn small', title: 'Copy as cURL' }),
      button('fetch', () => copyWithToast(toFetch(har), 'fetch() call copied'), { class: 'btn small', title: 'Copy as fetch' }),
      button('Save body', () => saveBody(entry), { class: 'btn small', title: 'Save response body to a file', disabled: entry.contentState !== 'loaded' }),
      button('×', () => selectEntry(null), { class: 'btn small icon', title: 'Close' }),
    );
    const content = h('div', { class: 'detail-body' });
    switch (detailTab) {
      case 'headers':
        append(content, headersTab(entry));
        break;
      case 'payload':
        append(content, payloadTab(entry));
        break;
      case 'response':
        append(content, responseTab(entry));
        break;
      case 'timing':
        content.append(timingTab(entry));
        break;
    }
    detail.replaceChildren(header, content);
  }

  function headersTab({ har, contentState }: NetEntry): Child[] {
    const general: [string, string][] = [
      ['Request URL', har.request.url],
      ['Method', har.request.method],
      ['Status', `${har.response.status} ${har.response.statusText}`.trim()],
      ['Remote address', har.serverIPAddress ?? '—'],
      ['Resource type', har._resourceType ?? '—'],
      ['Protocol', har.response.httpVersion || '—'],
      ['Started', har.startedDateTime],
      ['Duration', formatMs(har.time)],
      ['Body', contentState],
    ];
    return [
      section('General', kvTable(general)),
      section(`Response headers (${har.response.headers.length})`, headerTable(har.response.headers)),
      section(`Request headers (${har.request.headers.length})`, headerTable(har.request.headers)),
    ];
  }

  function payloadTab({ har }: NetEntry): Child[] {
    const out: Child[] = [];
    if (har.request.queryString.length > 0) out.push(section('Query string', headerTable(har.request.queryString)));
    const postData = har.request.postData;
    if (postData?.text !== undefined) {
      const parsed = maybeParseJson(postData.text, postData.mimeType);
      out.push(
        section(
          `Request body${postData.mimeType ? ` (${postData.mimeType})` : ''}`,
          typeof parsed === 'string' ? h('pre', { class: 'code' }, parsed) : renderTree(parsed, { expandDepth: 2 }).element,
          button('Copy', () => copyWithToast(postData.text!, 'Body copied'), { class: 'btn small' }),
        ),
      );
    } else if (postData?.params?.length) {
      out.push(section('Form data', headerTable(postData.params.map((p) => ({ name: p.name, value: p.value ?? p.fileName ?? '' })))));
    }
    if (out.length === 0) out.push(h('div', { class: 'empty' }, 'This request has no payload.'));
    return out;
  }

  function responseTab(entry: NetEntry): Child[] {
    const { har, contentState, content } = entry;
    const mime = har.response.content.mimeType ?? '';
    if (contentState === 'pending') return [h('div', { class: 'empty' }, 'Loading response body…')];
    if (contentState === 'empty') return [h('div', { class: 'empty' }, 'No response body.')];
    if (contentState === 'error') return [h('div', { class: 'empty' }, 'Response body is not available.')];
    if (contentState === 'too-large' || !content) {
      return [h('div', { class: 'empty' }, `Response body exceeds the ${store?.settings.maxBodyMB ?? '?'} MB limit and was not kept.`)];
    }

    if (content.encoding === 'base64') {
      if (mime.startsWith('image/')) {
        return [h('div', { class: 'image-preview' }, h('img', { src: `data:${mime};base64,${content.text}`, alt: '' }))];
      }
      return [h('div', { class: 'empty' }, `Binary body (${formatBytes(Math.floor((content.text.length * 3) / 4))}). Use "Save body" to download it.`)];
    }

    const parsed = isJsonMime(mime) || /^\s*[[{]/.test(content.text) ? maybeParseJson(content.text, mime) : content.text;
    if (typeof parsed === 'string') {
      const text = parsed.length > MAX_TEXT_DISPLAY ? `${parsed.slice(0, MAX_TEXT_DISPLAY)}\n… (truncated for display)` : parsed;
      return [h('pre', { class: 'code' }, text)];
    }

    const treeHost = h('div');
    const renderBody = () => {
      if (responseMode === 'raw') {
        treeHost.replaceChildren(h('pre', { class: 'code' }, JSON.stringify(parsed, null, 2)));
        return;
      }
      const tree = renderTree(parsed, { expandDepth: 2, query: responseQuery });
      matchInfo.textContent = responseQuery ? `${tree.matches} matches` : '';
      treeHost.replaceChildren(tree.element);
    };
    const search = h('input', { type: 'search', class: 'filter', placeholder: 'Search keys and values', value: responseQuery });
    let timer: ReturnType<typeof setTimeout> | undefined;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        responseQuery = search.value;
        renderBody();
      }, 150);
    });
    const matchInfo = h('span', { class: 'muted' });
    const modeSelect = select<'tree' | 'raw'>([['tree', 'Tree'], ['raw', 'Raw']], responseMode, (mode) => {
      responseMode = mode;
      renderBody();
    });
    const bar = h('div', { class: 'subbar' }, modeSelect, search, matchInfo, h('span', { class: 'spacer' }), button('Copy JSON', () => copyWithToast(content.text, 'Response copied'), { class: 'btn small' }));
    renderBody();
    return [bar, treeHost];
  }

  function timingTab({ har }: NetEntry): HTMLElement {
    const phases: [string, number | undefined][] = [
      ['Blocked', har.timings.blocked],
      ['DNS', har.timings.dns],
      ['Connect', har.timings.connect],
      ['SSL', har.timings.ssl],
      ['Send', har.timings.send],
      ['Waiting (TTFB)', har.timings.wait],
      ['Receive', har.timings.receive],
    ];
    const total = Math.max(har.time, 1);
    let offset = 0;
    const rowsEl = phases.map(([label, value]) => {
      const ms = value !== undefined && value > 0 ? value : 0;
      const bar = h('div', { class: 'timing-bar', style: { left: `${(offset / total) * 100}%`, width: `${Math.max((ms / total) * 100, ms > 0 ? 0.5 : 0)}%` } });
      if (label !== 'SSL') offset += ms; // SSL time is included in Connect
      return h('tr', null, h('td', null, label), h('td', { class: 'timing-track' }, bar), h('td', { class: 'c-num' }, ms > 0 ? formatMs(ms) : '—'));
    });
    return section(`Total ${formatMs(har.time)}`, h('table', { class: 'kv timing' }, h('tbody', null, ...rowsEl)));
  }

  function saveBody(entry: NetEntry) {
    if (!entry.content) return;
    const mime = entry.har.response.content.mimeType || 'application/octet-stream';
    let name = entryUrlName(entry.har).replace(/[^\w.-]+/g, '_') || 'response';
    if (!/\.\w{1,6}$/.test(name)) name += extensionFor(mime);
    if (entry.content.encoding === 'base64') {
      const binary = atob(entry.content.text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      downloadFile(name, bytes, mime);
    } else {
      downloadFile(name, entry.content.text, mime);
    }
  }

  return {
    attach(next: NetworkStore) {
      if (store === next) return;
      unsubscribe?.();
      store = next;
      rows.clear();
      unsubscribe = store.subscribe(onStoreEvent);
      renderSettings();
      rebuildList();
      list.scrollTop = list.scrollHeight;
    },
  };
}

function section(title: string, ...content: Child[]): HTMLElement {
  return h('details', { class: 'section', open: true }, h('summary', null, title), ...content);
}

function kvTable(pairs: [string, string][]): HTMLElement {
  return h('table', { class: 'kv' }, h('tbody', null, ...pairs.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v)))));
}

function headerTable(headers: (Header | QueryString)[]): HTMLElement {
  if (headers.length === 0) return h('div', { class: 'muted pad' }, 'None');
  return kvTable(headers.map((header) => [header.name, header.value]));
}

function extensionFor(mime: string): string {
  if (isJsonMime(mime)) return '.json';
  const map: Record<string, string> = {
    'text/html': '.html',
    'text/css': '.css',
    'text/plain': '.txt',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/xml': '.xml',
    'text/xml': '.xml',
  };
  return map[mime.split(';')[0].trim().toLowerCase()] ?? '.bin';
}

function loadFilter(): NetFilter {
  try {
    return { ...emptyFilter, ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') };
  } catch {
    return { ...emptyFilter };
  }
}

function saveFilter(filter: NetFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
  } catch {
    // storage unavailable
  }
}
