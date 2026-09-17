import { describe, expect, it } from 'vitest';
import { RecordingStore, fromExportFile, recordingFromForm, toExportFile, type Recording, type RecordingStorage } from '../src/panel/forms/storage';
import type { DetectedForm } from '../src/shared/messages';

const ORIGIN = 'https://app.example.fi';

function fakeStorage(initial: Recording[] = []): RecordingStorage & { written: Recording[][]; push(recordings: Recording[]): void } {
  let listener: ((recordings: Recording[]) => void) | undefined;
  return {
    written: [],
    async get() {
      return initial;
    },
    async set(recordings) {
      this.written.push(recordings);
    },
    onChanged(fn) {
      listener = fn;
    },
    push(recordings) {
      listener?.(recordings);
    },
  };
}

const detected: DetectedForm = {
  id: 'rf:store-1:signup',
  kind: 'redux-form',
  name: 'signup',
  key: 'signup',
  fields: [
    { path: 'email', kind: 'Field', value: 'a@b.fi', dirty: true, restorable: true },
    { path: 'country', kind: 'Field', value: 'fi', dirty: false, restorable: true },
    { path: 'attachment', kind: 'Field', value: { $devkit: 'opaque', kind: 'File' }, dirty: true, restorable: false },
  ],
};

describe('recordingFromForm', () => {
  it('saves the restorable fields and remembers where it was saved', () => {
    const recording = recordingFromForm(detected, 'Happy path', ORIGIN, '/signup');
    expect(recording.entries.map((entry) => entry.path)).toEqual(['email', 'country']);
    expect(recording).toMatchObject({ name: 'Happy path', origin: ORIGIN, path: '/signup', formKey: 'signup', kind: 'redux-form' });
  });

  it('fills in the changed fields and keeps the loaded ones off', () => {
    const recording = recordingFromForm(detected, 'Changed only', ORIGIN, '/signup');
    expect(recording.entries.map((entry) => [entry.path, entry.include])).toEqual([
      ['email', true],
      ['country', false],
    ]);
  });

  it('falls back to the value when a form has no dirty flags, as DOM forms do', () => {
    const dom: DetectedForm = {
      ...detected,
      kind: 'dom',
      fields: [
        { path: 'fullName', kind: 'text', value: 'Jukka', restorable: true },
        { path: 'comment', kind: 'textarea', value: { $devkit: 'undefined' }, restorable: true },
        { path: 'newsletter', kind: 'checkbox', value: false, restorable: true },
      ],
    };
    const recording = recordingFromForm(dom, 'Plain', ORIGIN, '/signup');
    expect(recording.entries.map((entry) => [entry.path, entry.include])).toEqual([
      ['fullName', true],
      ['comment', false],
      ['newsletter', false],
    ]);
  });
});

describe('RecordingStore', () => {
  it('saves, replaces and removes recordings', async () => {
    const storage = fakeStorage();
    const store = new RecordingStore(storage);
    await store.load();

    const saved = await store.save(recordingFromForm(detected, 'First', ORIGIN, '/signup'));
    expect(store.list()).toHaveLength(1);

    await store.save({ ...saved, name: 'Renamed' });
    expect(store.list()).toHaveLength(1);
    expect(store.get(saved.id)?.name).toBe('Renamed');

    await store.remove(saved.id);
    expect(store.list()).toEqual([]);
    expect(storage.written.at(-1)).toEqual([]);
  });

  it('notifies subscribers and picks up writes from another panel', async () => {
    const storage = fakeStorage();
    const store = new RecordingStore(storage);
    let changes = 0;
    store.subscribe(() => changes++);
    await store.load();

    const outside = recordingFromForm(detected, 'From another window', ORIGIN, '/signup');
    storage.push([outside]);

    expect(store.list()).toEqual([outside]);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('marks a recording as used', async () => {
    const store = new RecordingStore(fakeStorage());
    await store.load();
    const saved = await store.save(recordingFromForm(detected, 'First', ORIGIN, '/signup'));
    await store.markUsed(saved.id);
    expect(store.get(saved.id)?.lastUsedAt).toBeGreaterThan(0);
  });

  it('imports by id, so re-importing a file updates instead of duplicating', async () => {
    const store = new RecordingStore(fakeStorage());
    await store.load();
    const saved = await store.save(recordingFromForm(detected, 'First', ORIGIN, '/signup'));

    const file = toExportFile([{ ...saved, name: 'Edited elsewhere' }]);
    await store.import(fromExportFile(file, ORIGIN));

    expect(store.list()).toHaveLength(1);
    expect(store.get(saved.id)?.name).toBe('Edited elsewhere');
  });
});

describe('export files', () => {
  const saved = recordingFromForm(detected, 'Happy path', 'https://test.example.fi', '/signup');

  it('stamps imported recordings with the current origin', () => {
    const [imported] = fromExportFile(toExportFile([saved]), ORIGIN);
    expect(imported.origin).toBe(ORIGIN);
    expect(imported.entries).toEqual(saved.entries);
  });

  it('rejects files that are not recordings', () => {
    expect(() => fromExportFile('{', ORIGIN)).toThrow(/Invalid JSON/);
    expect(() => fromExportFile('{"version":1}', ORIGIN)).toThrow(/not a devkit recordings file/i);
    expect(() => fromExportFile('{"version":1,"recordings":[{"nope":1}]}', ORIGIN)).toThrow(/no recordings/i);
  });
});
