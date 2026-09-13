import { describe, expect, it } from 'vitest';
import { NetworkStore, type HarEntry, type NetEvent, type NetworkApi } from '../src/panel/network/store';
import { harEntry } from './fixtures';

function fakeApi() {
  let finished: ((request: any) => void) | undefined;
  let navigated: ((url: string) => void) | undefined;
  const api: NetworkApi = {
    onRequestFinished: { addListener: (cb) => (finished = cb) },
    onNavigated: { addListener: (cb) => (navigated = cb) },
  };
  return {
    api,
    finish(har: HarEntry, content: string, encoding = '') {
      finished!({ ...har, getContent: (cb: (c: string, e: string) => void) => cb(content, encoding) });
    },
    navigate: (url: string) => navigated!(url),
  };
}

async function setup(settings = {}) {
  const store = new NetworkStore();
  const fake = fakeApi();
  await store.start(fake.api);
  store.updateSettings(settings);
  const events: NetEvent['type'][] = [];
  store.subscribe((e) => events.push(e.type));
  return { store, fake, events };
}

describe('NetworkStore', () => {
  it('records plain HAR copies and their bodies', async () => {
    const { store, fake, events } = await setup();
    fake.finish(harEntry(), '{"ok":true}');
    fake.finish(harEntry(), 'AAAA', 'base64');
    fake.finish(harEntry(), '');

    expect(events).toEqual(['added', 'updated', 'added', 'updated', 'added', 'updated']);
    const [a, b, c] = store.entries;
    expect(a.har).not.toHaveProperty('getContent');
    expect(a).toMatchObject({ contentState: 'loaded', content: { text: '{"ok":true}' } });
    expect(b.content).toEqual({ text: 'AAAA', encoding: 'base64' });
    expect(c.contentState).toBe('empty');
  });

  it('does not keep bodies over the size limit', async () => {
    const { store, fake } = await setup({ maxBodyMB: 1 });
    fake.finish(harEntry(), 'x'.repeat(1024 * 1024 + 1));
    expect(store.entries[0].contentState).toBe('too-large');
    expect(store.entries[0].content).toBeUndefined();
  });

  it('ignores requests while paused', async () => {
    const { store, fake } = await setup({ recording: false });
    fake.finish(harEntry(), '');
    expect(store.entries).toHaveLength(0);
  });

  it('keeps the new document request when the page navigates', async () => {
    const { store, fake } = await setup();
    fake.finish(harEntry({ request: { url: 'https://old.example.com/a' } }), '');
    fake.finish(harEntry({ _resourceType: 'document', request: { url: 'https://new.example.com/' } }), '');
    fake.finish(harEntry({ request: { url: 'https://new.example.com/early.js' } }), '');
    fake.navigate('https://new.example.com/');
    expect(store.entries.map((e) => e.har.request.url)).toEqual(['https://new.example.com/', 'https://new.example.com/early.js']);
  });

  it('preserves the log across navigations when enabled', async () => {
    const { store, fake } = await setup({ preserveLog: true });
    fake.finish(harEntry(), '');
    fake.navigate('https://other.example.com/');
    expect(store.entries).toHaveLength(1);
  });

  it('takes requests only from Full capture while it is on', async () => {
    const { store, fake, events } = await setup({ fullCapture: true });
    fake.finish(harEntry({ request: { url: 'https://example.com/devtools' } }), '');
    store.addCaptured(harEntry({ request: { url: 'https://example.com/captured' } }), 'loaded', { text: '{}' });

    expect(events).toEqual(['added']);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ contentState: 'loaded', content: { text: '{}' }, har: { request: { url: 'https://example.com/captured' } } });

    store.updateSettings({ fullCapture: false });
    expect(store.addCaptured(harEntry(), 'empty')).toBeNull();
  });

  it('turns Full capture off and reports the failure once', async () => {
    const { store, events } = await setup({ fullCapture: true });
    store.failCapture('detached');
    expect(store.settings.fullCapture).toBe(false);
    expect(events).toEqual(['settings']);
    expect(store.takeCaptureError()).toBe('detached');
    expect(store.takeCaptureError()).toBeNull();
  });

  it('persists settings but always starts recording', async () => {
    let saved: object = { preserveLog: true, fullCapture: true };
    const store = new NetworkStore({ get: async () => ({ ...saved, recording: false }), set: async (s) => void (saved = s) });
    await store.start(fakeApi().api);
    expect(store.settings).toEqual({ recording: true, preserveLog: true, maxBodyMB: 5, fullCapture: true });

    store.updateSettings({ fullCapture: false, recording: false });
    expect(saved).toEqual({ preserveLog: true, maxBodyMB: 5, fullCapture: false });
  });

  it('drops listeners that throw', async () => {
    const { store, fake } = await setup();
    let calls = 0;
    store.subscribe(() => {
      calls++;
      throw new Error('dead window');
    });
    fake.finish(harEntry(), '');
    fake.finish(harEntry(), '');
    expect(calls).toBe(1);
  });
});
