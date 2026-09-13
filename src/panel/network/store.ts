import type { Entry as HarEntry } from 'har-format';

export type { HarEntry };

export type ContentState = 'pending' | 'loaded' | 'empty' | 'too-large' | 'error';

export interface NetEntry {
  id: number;
  har: HarEntry;
  contentState: ContentState;
  content?: { text: string; encoding?: string };
}

export type NetEvent =
  | { type: 'added'; entry: NetEntry }
  | { type: 'updated'; entry: NetEntry }
  | { type: 'removed'; ids: number[] }
  | { type: 'cleared' }
  | { type: 'settings' };

export interface NetSettings {
  recording: boolean;
  preserveLog: boolean;
  maxBodyMB: number;
  /** Record with `chrome.debugger` instead of `chrome.devtools.network`, see capture-client.ts. */
  fullCapture: boolean;
}

type RequestFinished = HarEntry & {
  getContent(callback: (content: string, encoding: string) => void): void;
};

export interface NetworkApi {
  onRequestFinished: { addListener(cb: (request: RequestFinished) => void): void };
  onNavigated: { addListener(cb: (url: string) => void): void };
}

export interface SettingsStorage {
  get(): Promise<Partial<NetSettings>>;
  set(settings: Partial<NetSettings>): Promise<void>;
}

const MAX_ENTRIES = 5000;
const SETTINGS_KEY = 'network.settings';

export const chromeSettingsStorage: SettingsStorage = {
  async get() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return (data[SETTINGS_KEY] as Partial<NetSettings> | undefined) ?? {};
  },
  async set(settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  },
};

/**
 * Records requests from `chrome.devtools.network`. Lives in the DevTools page so
 * capturing starts as soon as DevTools opens, before the panel is first shown.
 */
export class NetworkStore {
  readonly entries: NetEntry[] = [];
  settings: NetSettings = { recording: true, preserveLog: false, maxBodyMB: 5, fullCapture: false };

  private nextId = 1;
  private captureError: string | null = null;
  private readonly listeners = new Set<(event: NetEvent) => void>();

  constructor(private readonly storage?: SettingsStorage) {}

  async start(api: NetworkApi): Promise<void> {
    api.onRequestFinished.addListener((request) => this.add(request));
    api.onNavigated.addListener((url) => this.navigated(url));
    if (this.storage) {
      try {
        const saved = await this.storage.get();
        this.settings = { ...this.settings, ...saved, recording: true };
        this.emit({ type: 'settings' });
      } catch {
        // storage unavailable, keep defaults
      }
    }
  }

  subscribe(listener: (event: NetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateSettings(patch: Partial<NetSettings>): void {
    this.settings = { ...this.settings, ...patch };
    const { preserveLog, maxBodyMB, fullCapture } = this.settings;
    void this.storage?.set({ preserveLog, maxBodyMB, fullCapture }).catch(() => {});
    this.emit({ type: 'settings' });
  }

  /** Turns Full capture off after the debugger session failed or was closed. */
  failCapture(message: string): void {
    this.captureError = message;
    this.updateSettings({ fullCapture: false });
  }

  /** Returns the last Full capture failure once, so it is reported a single time. */
  takeCaptureError(): string | null {
    const error = this.captureError;
    this.captureError = null;
    return error;
  }

  clear(): void {
    this.entries.length = 0;
    this.emit({ type: 'cleared' });
  }

  get(id: number): NetEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(request: RequestFinished): NetEntry | null {
    // Full capture sees the same requests; avoid duplicates.
    if (!this.settings.recording || this.settings.fullCapture) return null;

    const entry = this.record(toPlainEntry(request), 'pending');
    const maxChars = this.settings.maxBodyMB * 1024 * 1024;
    try {
      request.getContent((content, encoding) => {
        if (content === null || content === undefined || content === '') {
          entry.contentState = 'empty';
        } else if (content.length > maxChars) {
          entry.contentState = 'too-large';
        } else {
          entry.content = encoding ? { text: content, encoding } : { text: content };
          entry.contentState = 'loaded';
        }
        this.emit({ type: 'updated', entry });
      });
    } catch {
      entry.contentState = 'error';
      this.emit({ type: 'updated', entry });
    }
    return entry;
  }

  /** Adds a request recorded by Full capture, with its body already loaded. */
  addCaptured(har: HarEntry, contentState: ContentState, content?: NetEntry['content']): NetEntry | null {
    if (!this.settings.recording || !this.settings.fullCapture) return null;
    return this.record(har, contentState, content);
  }

  private record(har: HarEntry, contentState: ContentState, content?: NetEntry['content']): NetEntry {
    const entry: NetEntry = content ? { id: this.nextId++, har, contentState, content } : { id: this.nextId++, har, contentState };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      this.emit({ type: 'removed', ids: removed.map((e) => e.id) });
    }
    this.emit({ type: 'added', entry });
    return entry;
  }

  /**
   * DevTools reports navigation after the new document request has already
   * finished, so keep that document request and everything after it.
   */
  navigated(url: string): void {
    if (this.settings.preserveLog) return;
    let keepFrom = this.entries.length;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const har = this.entries[i].har;
      if (har._resourceType === 'document' && har.request.url === url) {
        keepFrom = i;
        break;
      }
    }
    const removed = this.entries.splice(0, keepFrom);
    if (removed.length === 0) return;
    if (this.entries.length === 0) this.emit({ type: 'cleared' });
    else this.emit({ type: 'removed', ids: removed.map((e) => e.id) });
  }

  private emit(event: NetEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A listener from a reloaded panel window may be dead; drop it.
        this.listeners.delete(listener);
      }
    }
  }
}

function toPlainEntry(request: RequestFinished): HarEntry {
  // Drops getContent and any other non-JSON members.
  return JSON.parse(JSON.stringify(request)) as HarEntry;
}
