// @vitest-environment jsdom
// The detail pane is rebuilt on every change, which used to fight with focus:
// the buttons live in the pane they redraw.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFormsView } from '../src/panel/forms/view';
import type { Recording, RecordingStorage } from '../src/panel/forms/storage';
import type { ReduxClient } from '../src/panel/redux/client';
import type { DetectedForm, FillEntry, RequestMap } from '../src/shared/messages';

const ORIGIN = 'https://app.example.fi';

/** The page's form, with values a fill can change. */
function page() {
  const values: Record<string, unknown> = { applicant: undefined, email: undefined };
  const form = (): DetectedForm => ({
    id: 'rf:store-1:application',
    kind: 'redux-form',
    name: 'application',
    key: 'application',
    // Like redux-form: a field is dirty once it holds something the app did not load.
    fields: Object.entries(values).map(([path, value]) => ({ path, kind: 'Field', value, dirty: value !== undefined, restorable: true })),
  });

  const client = {
    onEvent: () => undefined,
    onReconnect: () => undefined,
    request: (method: keyof RequestMap, params: unknown) => {
      if (method === 'forms/list') return Promise.resolve({ forms: [form()], url: `${ORIGIN}/hakemus` });
      const entries = (params as { entries: FillEntry[] }).entries;
      for (const entry of entries) values[entry.path] = entry.value;
      return Promise.resolve({ filled: entries.map((entry) => entry.path), skipped: [] });
    },
  } as unknown as ReduxClient;

  return { client, values };
}

function recording(name: string, entries: [string, unknown][]): Recording {
  return {
    id: `r-${name}`,
    name,
    kind: 'redux-form',
    formKey: 'application',
    formName: 'application',
    origin: ORIGIN,
    path: '/hakemus',
    entries: entries.map(([path, value]) => ({ path, kind: 'Field', value, include: true })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function memoryStorage(recordings: Recording[]): RecordingStorage {
  let stored = recordings;
  return {
    get: async () => stored,
    set: async (next) => {
      stored = next;
    },
  };
}

/** Lets the view's awaits and its verify timeout run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
}

function currentValues(root: HTMLElement): Record<string, string> {
  const rows = [...root.querySelectorAll('.field-table tbody tr')];
  return Object.fromEntries(rows.map((row) => [row.querySelector('.c-field')!.textContent, row.querySelector('.c-current')!.textContent]));
}

function drawerButton(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('.drawer button')].find((el) => el.textContent === label);
  if (!found) throw new Error(`No “${label}” button in the save drawer`);
  return found;
}

function detailButton(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('.rec-head button')].find((el) => el.textContent === label);
  if (!found) throw new Error(`No “${label}” button in the detail pane`);
  return found;
}

/** jsdom does not focus a clicked button; Chrome does, which is what the bug needed. */
function click(el: HTMLElement): void {
  el.focus();
  el.click();
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  vi.useRealTimers();
  root.remove();
});

async function openView(recordings: Recording[]) {
  const target = page();
  const view = createFormsView(root, target.client, { onNavigated: () => undefined }, memoryStorage(recordings));
  await settle();
  return { ...target, view };
}

async function openRecording(recordings: Recording[]) {
  const opened = await openView(recordings);
  click(root.querySelector<HTMLElement>('.rec-row')!);
  return opened;
}

it('shows the new current value after filling from the detail pane', async () => {
  const target = await openRecording([recording('eka', [['applicant', 'jukka']])]);

  click(detailButton(root, 'Fill'));
  await settle();

  expect(target.values.applicant).toBe('jukka');
  expect(currentValues(root).applicant).toBe('"jukka"');
  // The redraw replaced the button, so Fill can be pressed again right away.
  expect(document.activeElement).toBe(detailButton(root, 'Fill'));
});

it('shows the new saved values after updating from the form', async () => {
  const target = await openRecording([recording('eka', [['applicant', 'vanha']])]);
  target.values.applicant = 'uusi';
  target.view.refresh();
  await settle();

  click(detailButton(root, 'Update from form'));
  await settle();

  const saved = [...root.querySelectorAll<HTMLInputElement>('.field-table .value-input')].map((input) => input.value);
  expect(saved).toContain('uusi');
});

it('does not redraw the table while a value is being typed', async () => {
  const { view } = await openRecording([recording('eka', [['applicant', 'jukka']])]);

  const input = root.querySelector<HTMLInputElement>('.field-table .value-input')!;
  input.focus();
  input.value = 'kesken';
  view.refresh();
  await settle();

  expect(root.querySelector<HTMLInputElement>('.field-table .value-input')!.value).toBe('kesken');
});

it('saves the values the form has when Save is pressed, not when the drawer was opened', async () => {
  const target = await openView([]);

  click([...root.querySelectorAll<HTMLButtonElement>('.form-group-head button')].find((el) => el.textContent === 'Save values…')!);
  const name = root.querySelector<HTMLInputElement>('.drawer .name-input')!;
  name.value = 'eka';
  click(drawerButton(root, 'Save'));
  await settle();
  expect(root.querySelector('.rec-row')).toBeNull();
  expect(document.getElementById('toast')!.textContent).toBe('No changed fields to save');

  // The drawer stays open; the user fills the form on the page and presses Save again.
  target.values.applicant = 'jukka';
  click(drawerButton(root, 'Save'));
  await settle();

  expect(root.querySelector('.rec-row .rec-name')!.textContent).toBe('eka');
  expect(root.querySelector<HTMLInputElement>('.field-table .value-input')!.value).toBe('jukka');
});
