import type { DetectedForm, FillEntry, RequestMap } from '../../shared/messages';
import { button, checkbox, downloadFile, h, pickFile, safeFilePart, timestampForFile, toast } from '../ui/dom';
import { createSplit } from '../ui/split';
import { inlinePreview } from '../ui/tree';
import { PageUnavailableError, type ReduxClient } from '../redux/client';
import { compareEntries, extraFields, matchRecordings, unappliedFields, unmatchedRecordings, type CompareRow } from './match';
import {
  RecordingStore,
  chromeRecordingStorage,
  fromExportFile,
  newId,
  recordingFromForm,
  toExportFile,
  type Recording,
  type RecordingEntry,
  type RecordingStorage,
} from './storage';

const TOUCH_KEY = 'forms.touch';
/** How long the app is given to react before the fill is checked. */
const VERIFY_MS = 600;
const REFRESH_MS = 300;

export interface NavigationSource {
  onNavigated(listener: () => void): void;
}

export interface FormsView {
  /** Re-reads the page's forms; called when the tab is shown. */
  refresh(): void;
}

export function createFormsView(root: HTMLElement, client: ReduxClient, navigation: NavigationSource, storage: RecordingStorage = chromeRecordingStorage): FormsView {
  const store = new RecordingStore(storage);
  let forms: DetectedForm[] = [];
  let origin = '';
  let pagePath = '';
  let selectedId: string | null = null;
  let saveTarget: DetectedForm | null = null;
  let search = '';
  let touchAfterFill = readTouch();
  let listToken = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;

  // ── toolbar ────────────────────────────────────────────────────────────
  const refreshBtn = button('Refresh', () => void refresh(), { title: 'Look for forms on the page again' });
  const importBtn = button('Import', () => void importRecordings(), { title: 'Add recordings from a JSON file' });
  const exportBtn = button('Export', () => exportRecordings(), { title: "Save this origin's recordings as JSON" });
  const touchCheck = checkbox('Touch fields', touchAfterFill, (checked) => {
    touchAfterFill = checked;
    writeTouch(checked);
  }, 'Mark the filled fields touched so validation messages show');
  const statusText = h('span', { class: 'muted status' });
  const toolbar = h('div', { class: 'toolbar' }, refreshBtn, h('span', { class: 'sep' }), importBtn, exportBtn, h('span', { class: 'sep' }), touchCheck, h('span', { class: 'spacer' }), statusText);

  const banner = h('div', { class: 'banner', hidden: true });

  // ── recording list ─────────────────────────────────────────────────────
  const searchInput = h('input', { type: 'search', class: 'filter', placeholder: 'Filter recordings' });
  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLowerCase();
    renderList();
  });
  const groups = h('div', { class: 'forms-groups' });
  const listEmpty = h('div', { class: 'empty' });
  const left = h('div', { class: 'column' }, h('div', { class: 'subbar' }, searchInput), h('div', { class: 'scroll' }, groups, listEmpty));

  // ── detail ─────────────────────────────────────────────────────────────
  const detail = h('div', { class: 'scroll pad' });
  const right = h('div', { class: 'column' }, detail);

  // ── save drawer ────────────────────────────────────────────────────────
  const nameInput = h('input', { type: 'text', class: 'name-input', placeholder: 'Recording name' });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void saveRecording();
    if (event.key === 'Escape') closeSave();
  });
  const dirtyOnly = checkbox('Only changed fields', true, () => undefined, 'Leave out fields that still hold the value the app loaded');
  const drawerTitle = h('span', { class: 'muted' });
  const drawer = h(
    'div',
    { class: 'drawer', hidden: true },
    h(
      'div',
      { class: 'subbar' },
      drawerTitle,
      nameInput,
      dirtyOnly,
      button('Save', () => void saveRecording(), { class: 'btn primary' }),
      h('span', { class: 'spacer' }),
      button('Close', () => closeSave()),
    ),
  );

  root.append(toolbar, banner, h('div', { class: 'view-body' }, createSplit(left, right, { initial: 40, storageKey: 'forms.split' })), drawer);
  renderAll();

  // ── wiring ─────────────────────────────────────────────────────────────
  store.subscribe(() => renderAll());
  void store.load();

  client.onReconnect(() => scheduleRefresh());
  navigation.onNavigated(() => scheduleRefresh());
  client.onEvent((event) => {
    // redux-form actions mean fields were registered, changed or the form was reset.
    if (event.kind === 'actions' && event.entries.some((entry) => entry.type.startsWith('@@redux-form/'))) scheduleRefresh();
  });
  void refresh();

  return { refresh: () => void refresh() };

  // ── actions ────────────────────────────────────────────────────────────
  function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), REFRESH_MS);
  }

  async function refresh(): Promise<void> {
    const token = ++listToken;
    clearTimeout(refreshTimer);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await client.request('forms/list', undefined);
        if (token !== listToken) return;
        apply(result);
        return;
      } catch (err) {
        if (token !== listToken) return;
        if (!(err instanceof PageUnavailableError)) {
          setStatus(message(err));
          return;
        }
        setStatus('Connecting to page…');
        await delay(300 + attempt * 200);
        if (token !== listToken) return;
      }
    }
    setStatus('Page is not reachable. Reload the page if the extension was installed or updated after it was opened.');
  }

  function apply(result: RequestMap['forms/list']['result']): void {
    forms = result.forms;
    try {
      const url = new URL(result.url);
      origin = url.origin;
      pagePath = url.pathname;
    } catch {
      origin = result.url;
      pagePath = '';
    }
    setStatus('');
    renderAll();
  }

  async function request<M extends keyof RequestMap>(method: M, params: RequestMap[M]['params']): Promise<RequestMap[M]['result'] | undefined> {
    try {
      return await client.request(method, params);
    } catch (err) {
      toast(message(err), 'error');
      return undefined;
    }
  }

  async function fill(recording: Recording): Promise<void> {
    const form = formFor(recording);
    if (!form) return toast('That form is not on the page right now', 'error');
    const entries: FillEntry[] = recording.entries.filter((entry) => entry.include).map((entry) => ({ path: entry.path, value: entry.value }));
    if (entries.length === 0) return toast('No fields are selected in this recording', 'error');

    setBanner(null);
    const result = await request('forms/fill', { formId: form.id, entries, touch: touchAfterFill });
    if (!result) return;
    void store.markUsed(recording.id);
    if (result.skipped.length > 0) {
      toast(`Filled ${result.filled.length} fields, skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}`, 'error');
    } else {
      toast(`Filled ${result.filled.length} fields`);
    }
    scheduleVerify(recording.id);
  }

  /** Apps often reset dependent fields after a change, so the result is checked. */
  function scheduleVerify(recordingId: string): void {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(async () => {
      await refresh();
      const recording = store.get(recordingId);
      if (!recording) return;
      const unapplied = unappliedFields(recording, formFor(recording));
      if (unapplied.length === 0) return;
      setBanner({
        text: `${unapplied.length} field(s) did not keep the saved value: ${unapplied.join(', ')}. The app probably reset them.`,
        recording,
      });
    }, VERIFY_MS);
  }

  function openSave(form: DetectedForm): void {
    saveTarget = form;
    drawerTitle.textContent = `Save values of “${form.name}”`;
    nameInput.value = defaultName(form);
    dirtyOnly.hidden = form.kind !== 'redux-form';
    drawer.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  function closeSave(): void {
    saveTarget = null;
    drawer.hidden = true;
  }

  async function saveRecording(): Promise<void> {
    const form = saveTarget;
    if (!form) return;
    const name = nameInput.value.trim();
    if (!name) return toast('Give the recording a name', 'error');
    const onlyDirty = form.kind === 'redux-form' && dirtyInput().checked;
    const recording = recordingFromForm(form, name, origin, pagePath, onlyDirty);
    if (recording.entries.length === 0) return toast(onlyDirty ? 'No changed fields to save' : 'This form has no values to save', 'error');
    await store.save(recording);
    selectedId = recording.id;
    closeSave();
    toast(`Saved ${recording.entries.length} fields`);
    renderAll();
  }

  async function updateFromForm(recording: Recording): Promise<void> {
    const form = formFor(recording);
    if (!form) return toast('That form is not on the page right now', 'error');
    const previous = new Map(recording.entries.map((entry) => [entry.path, entry.include]));
    const entries: RecordingEntry[] = form.fields
      .filter((field) => field.restorable)
      .map((field) => ({ path: field.path, kind: field.kind, value: field.value, include: previous.get(field.path) ?? true }));
    await store.save({ ...recording, entries, formKey: form.key, formName: form.name });
    toast(`Updated ${entries.length} fields from the form`);
  }

  async function duplicate(recording: Recording): Promise<void> {
    const copy = await store.save({
      ...recording,
      id: newId(),
      name: `${recording.name} (copy)`,
      createdAt: Date.now(),
      lastUsedAt: undefined,
    });
    selectedId = copy.id;
    renderAll();
  }

  async function remove(recording: Recording): Promise<void> {
    await store.remove(recording.id);
    if (selectedId === recording.id) selectedId = null;
    toast(`Deleted “${recording.name}”`);
    renderAll();
  }

  function exportRecordings(): void {
    const mine = store.list().filter((recording) => recording.origin === origin);
    if (mine.length === 0) return toast('No recordings on this origin yet', 'error');
    downloadFile(`devkit-forms-${safeFilePart(origin.replace(/^https?:\/\//, ''))}-${timestampForFile()}.json`, toExportFile(mine));
    toast(`Exported ${mine.length} recordings`);
  }

  async function importRecordings(): Promise<void> {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const imported = fromExportFile(await file.text(), origin);
      const count = await store.import(imported);
      toast(`Imported ${count} recordings to ${origin}`);
      renderAll();
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  async function patch(recording: Recording, changes: Partial<Recording>): Promise<void> {
    await store.save({ ...recording, ...changes });
  }

  // ── data ───────────────────────────────────────────────────────────────
  function setStatus(text: string): void {
    statusText.textContent = text;
    statusText.title = text;
  }

  function setBanner(value: { text: string; recording: Recording } | null): void {
    banner.hidden = value === null;
    if (!value) return;
    banner.replaceChildren(h('span', null, value.text), button('Fill again', () => void fill(value.recording), { class: 'btn primary small' }));
  }

  function selected(): Recording | undefined {
    return selectedId ? store.get(selectedId) : undefined;
  }

  /** The detected form a recording belongs to, if it is on the page. */
  function formFor(recording: Recording): DetectedForm | undefined {
    return forms.find((form) => matchRecordings(form, [recording], origin).length > 0);
  }

  function matchesSearch(recording: Recording): boolean {
    if (!search) return true;
    return `${recording.name}\n${recording.formName}\n${recording.notes ?? ''}`.toLowerCase().includes(search);
  }

  function dirtyInput(): HTMLInputElement {
    return dirtyOnly.querySelector('input')!;
  }

  // ── rendering ──────────────────────────────────────────────────────────
  function renderAll(): void {
    renderList();
    renderDetail();
  }

  function renderList(): void {
    const recordings = store.list();
    const rendered: Node[] = [];

    for (const form of forms) {
      const matches = matchRecordings(form, recordings, origin).filter((match) => matchesSearch(match.recording));
      const filled = form.fields.filter((field) => hasValue(field.value)).length;
      rendered.push(
        h(
          'div',
          { class: 'form-group' },
          h(
            'div',
            { class: 'form-group-head' },
            h('span', { class: 'form-group-name', title: form.detail ?? form.name }, form.name),
            h('span', { class: `badge ${form.kind === 'redux-form' ? 'hooked' : 'limited'}`, title: form.detail ?? '' }, form.kind),
            h('span', { class: 'muted' }, `${form.fields.length} fields · ${filled} filled`),
            h('span', { class: 'spacer' }),
            button('Save values…', () => openSave(form), { class: 'btn small' }),
          ),
          matches.length > 0
            ? h('ul', { class: 'rec-list' }, ...matches.map((match) => recordingRow(match.recording, match.exact ? undefined : `Partial match (${Math.round(match.score * 100)}% of fields)`)))
            : h('div', { class: 'rec-empty muted' }, search ? 'No recordings match the filter.' : 'No recordings for this form yet — fill it and save the values.'),
        ),
      );
    }

    const others = unmatchedRecordings(forms, recordings, origin).filter(matchesSearch);
    if (others.length > 0) {
      rendered.push(
        h(
          'details',
          { class: 'form-group', open: forms.length === 0 },
          h('summary', { class: 'form-group-head' }, h('span', { class: 'form-group-name' }, 'Other recordings on this origin'), h('span', { class: 'muted' }, String(others.length))),
          h('ul', { class: 'rec-list' }, ...others.map((recording) => recordingRow(recording, `Form “${recording.formName}” is not on this page`))),
        ),
      );
    }

    groups.replaceChildren(...rendered);
    listEmpty.hidden = rendered.length > 0;
    if (rendered.length === 0) {
      listEmpty.replaceChildren(
        h('p', null, 'No forms detected on this page.'),
        h(
          'p',
          { class: 'muted' },
          'redux-form forms are read from the Redux store, so a store must be found first (see the Redux tab). Other React forms are read from their native inputs. Open a page with a form and press Refresh.',
        ),
      );
    }
  }

  function recordingRow(recording: Recording, note?: string): HTMLElement {
    const classes = ['rec-row'];
    if (recording.id === selectedId) classes.push('selected');
    const row = h(
      'li',
      { class: classes.join(' '), title: note ?? `${recording.entries.length} fields` },
      h('span', { class: 'rec-name' }, recording.name),
      h('span', { class: 'rec-meta muted' }, `${recording.entries.filter((entry) => entry.include).length} fields${recording.lastUsedAt ? ` · used ${formatDate(recording.lastUsedAt)}` : ''}`),
      note ? h('span', { class: 'rec-note muted', title: note }, '!') : null,
      h('button', { type: 'button', class: 'mini', title: 'Fill the form with these values', onClick: (event: MouseEvent) => (event.stopPropagation(), void fill(recording)) }, 'fill'),
    );
    row.addEventListener('click', () => {
      selectedId = recording.id;
      renderAll();
    });
    row.addEventListener('dblclick', () => void fill(recording));
    return row;
  }

  function renderDetail(): void {
    const recording = selected();
    // Keep the table stable while a value is being edited.
    if (detail.contains(document.activeElement) && document.activeElement !== detail) return;

    if (!recording) {
      detail.replaceChildren(h('div', { class: 'empty' }, forms.length > 0 ? 'Select a recording, or save a form’s current values.' : ''));
      return;
    }

    const form = formFor(recording);
    const rows = compareEntries(recording, form);
    const extras = extraFields(recording, form);

    const name = h('input', { type: 'text', class: 'name-input', value: recording.name });
    name.addEventListener('change', () => void patch(recording, { name: name.value.trim() || recording.name }));
    const notes = h('input', { type: 'text', class: 'name-input', value: recording.notes ?? '', placeholder: 'Notes (optional)' });
    notes.addEventListener('change', () => void patch(recording, { notes: notes.value.trim() || undefined }));

    const head = h(
      'div',
      { class: 'detail-head' },
      name,
      notes,
      h(
        'div',
        { class: 'subbar' },
        button('Fill', () => void fill(recording), { class: 'btn primary', disabled: !form }),
        button('Update from form', () => void updateFromForm(recording), { title: "Replace the saved values with the form's current values", disabled: !form }),
        button('Duplicate', () => void duplicate(recording)),
        button('Delete', () => void remove(recording), { class: 'btn danger' }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted detail-meta' }, `${recording.kind} · ${recording.formName} · saved ${formatDate(recording.createdAt)}${recording.path ? ` on ${recording.path}` : ''}`),
      ),
    );

    detail.replaceChildren(head);
    if (!form) detail.append(h('div', { class: 'rec-empty muted' }, 'This form is not on the page right now, so values cannot be compared or filled.'));
    detail.append(fieldTable(recording, rows));
    if (extras.length > 0) {
      detail.append(h('div', { class: 'rec-empty muted' }, `The form has ${extras.length} field(s) this recording does not set: ${extras.join(', ')}`));
    }
  }

  function fieldTable(recording: Recording, rows: CompareRow[]): HTMLElement {
    return h(
      'table',
      { class: 'grid field-table' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Field'), h('th', null, 'Saved value'), h('th', null, 'Current value'))),
      h(
        'tbody',
        null,
        ...rows.map((row) => {
          const include = h('input', { type: 'checkbox', checked: row.include, title: 'Fill this field' });
          include.addEventListener('change', () => void setEntry(recording, row.path, { include: include.checked }));

          const value = h('input', { type: 'text', class: 'value-input', value: valueText(row.saved), spellcheck: 'false' });
          value.addEventListener('change', () => {
            try {
              void setEntry(recording, row.path, { value: parseValueText(value.value, row.saved) });
            } catch (err) {
              toast(`Invalid value: ${message(err)}`, 'error');
              value.value = valueText(row.saved);
            }
          });

          return h(
            'tr',
            { class: `row-${row.status}` },
            h('td', null, include),
            h('td', { class: 'c-field', title: `${row.path} (${row.kind})` }, row.path),
            h('td', null, value),
            h('td', { class: 'c-current', title: row.status === 'missing' ? 'This field is not in the form right now' : '' }, row.status === 'missing' ? '—' : inlinePreview(row.current, 120)),
          );
        }),
      ),
    );
  }

  async function setEntry(recording: Recording, path: string, changes: Partial<RecordingEntry>): Promise<void> {
    const entries = recording.entries.map((entry) => (entry.path === path ? { ...entry, ...changes } : entry));
    await patch(recording, { entries });
  }
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
}

/** Strings are edited as plain text, everything else as JSON. */
function parseValueText(text: string, previous: unknown): unknown {
  if (typeof previous === 'string') return text;
  return JSON.parse(text);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return (value as Record<string, unknown>).$devkit !== 'undefined';
  return true;
}

function defaultName(form: DetectedForm): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${form.name} ${p(now.getDate())}.${p(now.getMonth() + 1)}. ${p(now.getHours())}:${p(now.getMinutes())}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTouch(): boolean {
  try {
    return localStorage.getItem(TOUCH_KEY) === '1';
  } catch {
    return false;
  }
}

function writeTouch(value: boolean): void {
  try {
    localStorage.setItem(TOUCH_KEY, value ? '1' : '0');
  } catch {
    // storage unavailable
  }
}
