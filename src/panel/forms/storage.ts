import type { DetectedForm, FormField, FormKind } from '../../shared/messages';

export interface RecordingEntry {
  path: string;
  kind: string;
  /** Value as it came from the page, in `serialize()` form. */
  value: unknown;
  /** Unchecked entries are kept but not written when filling. */
  include: boolean;
}

/** A named set of form values, saved for one form on one origin. */
export interface Recording {
  id: string;
  name: string;
  notes?: string;
  kind: FormKind;
  /** Matching key: the redux-form name, or the DOM form's path pattern and label. */
  formKey: string;
  formName: string;
  /** Recordings are only offered on the origin they were saved on. */
  origin: string;
  path: string;
  entries: RecordingEntry[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface RecordingFile {
  version: number;
  recordings: Recording[];
}

export const EXPORT_VERSION = 1;
const STORAGE_KEY = 'forms.recordings';

export interface RecordingStorage {
  get(): Promise<Recording[]>;
  set(recordings: Recording[]): Promise<void>;
  /** Notifies about writes from elsewhere, e.g. a second DevTools window. */
  onChanged?(listener: (recordings: Recording[]) => void): void;
}

export const chromeRecordingStorage: RecordingStorage = {
  async get() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const stored = data[STORAGE_KEY] as unknown;
    return Array.isArray(stored) ? stored.filter(isRecording) : [];
  },
  async set(recordings) {
    await chrome.storage.local.set({ [STORAGE_KEY]: recordings });
  },
  onChanged(listener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      const next = changes[STORAGE_KEY].newValue as unknown;
      listener(Array.isArray(next) ? next.filter(isRecording) : []);
    });
  },
};

/** Keeps the recordings in memory and writes every change through to storage. */
export class RecordingStore {
  private recordings: Recording[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: RecordingStorage) {}

  async load(): Promise<void> {
    this.recordings = await this.storage.get();
    this.storage.onChanged?.((recordings) => {
      this.recordings = recordings;
      this.emit();
    });
    this.emit();
  }

  list(): readonly Recording[] {
    return this.recordings;
  }

  get(id: string): Recording | undefined {
    return this.recordings.find((recording) => recording.id === id);
  }

  subscribe(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Inserts or replaces a recording and returns the stored copy. */
  async save(recording: Recording): Promise<Recording> {
    const stored: Recording = { ...recording, updatedAt: Date.now() };
    const index = this.recordings.findIndex((candidate) => candidate.id === stored.id);
    if (index === -1) this.recordings = [...this.recordings, stored];
    else this.recordings = this.recordings.map((candidate, i) => (i === index ? stored : candidate));
    await this.flush();
    return stored;
  }

  async remove(id: string): Promise<void> {
    this.recordings = this.recordings.filter((recording) => recording.id !== id);
    await this.flush();
  }

  async markUsed(id: string): Promise<void> {
    const recording = this.get(id);
    if (!recording) return;
    await this.save({ ...recording, lastUsedAt: Date.now() });
  }

  /** Upserts imported recordings by id, so re-importing a file updates in place. */
  async import(recordings: Recording[]): Promise<number> {
    const byId = new Map(this.recordings.map((recording) => [recording.id, recording]));
    for (const recording of recordings) byId.set(recording.id, recording);
    this.recordings = [...byId.values()];
    await this.flush();
    return recordings.length;
  }

  private async flush(): Promise<void> {
    this.emit();
    await this.storage.set(this.recordings);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Whether a field is filled in by default, which is what a fill then writes.
 * Everything else is kept in the recording, one tick away from being used: a
 * field the app loaded, or an empty one that clears the field when filled.
 */
export function defaultInclude(field: FormField): boolean {
  return field.dirty ?? hasValue(field.value);
}

/** True for a value the user would call filled in; an empty one reads as `undefined`. */
export function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '' || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return (value as Record<string, unknown>).$devkit !== 'undefined';
  return true;
}

/** Builds a recording from a form's current values. */
export function recordingFromForm(form: DetectedForm, name: string, origin: string, path: string): Recording {
  const now = Date.now();
  const fields = form.fields.filter((field) => field.restorable);
  return {
    id: newId(),
    name,
    kind: form.kind,
    formKey: form.key,
    formName: form.name,
    origin,
    path,
    entries: fields.map((field) => ({ path: field.path, kind: field.kind, value: field.value, include: defaultInclude(field) })),
    createdAt: now,
    updatedAt: now,
  };
}

export function newId(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function toExportFile(recordings: readonly Recording[]): string {
  const file: RecordingFile = { version: EXPORT_VERSION, recordings: [...recordings] };
  return JSON.stringify(file, null, 2);
}

/**
 * Reads an exported file. Recordings are origin scoped, so an import is also
 * how they move between environments: every one is stamped with `origin`.
 */
export function fromExportFile(text: string, origin: string): Recording[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recordings = (parsed as RecordingFile | null)?.recordings;
  if (!Array.isArray(recordings)) throw new Error('Not a DevKit recordings file');
  const valid = recordings.filter(isRecording);
  if (valid.length === 0) throw new Error('The file has no recordings');
  return valid.map((recording) => ({ ...recording, origin }));
}

function isRecording(value: unknown): value is Recording {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Recording>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.formKey === 'string' &&
    (record.kind === 'redux-form' || record.kind === 'dom') &&
    Array.isArray(record.entries) &&
    record.entries.every((entry) => typeof entry?.path === 'string')
  );
}
