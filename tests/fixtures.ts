import type { HarEntry, NetEntry } from '../src/panel/network/store';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function harEntry(overrides: DeepPartial<HarEntry> = {}): HarEntry {
  const base: HarEntry = {
    pageref: 'page_1',
    startedDateTime: '2026-09-13T10:00:00.000Z',
    time: 42.5,
    _resourceType: 'fetch',
    request: {
      method: 'GET',
      url: 'https://api.example.com/users?page=2',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'Cookie', value: 'sid=abc' },
      ],
      queryString: [{ name: 'page', value: '2' }],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
      content: { size: 17, mimeType: 'application/json' },
      redirectURL: '',
      headersSize: -1,
      bodySize: 17,
    },
    cache: {},
    timings: { send: 1, wait: 40, receive: 1.5 },
  };
  return {
    ...base,
    ...overrides,
    request: { ...base.request, ...overrides.request },
    response: { ...base.response, ...overrides.response, content: { ...base.response.content, ...overrides.response?.content } },
  } as HarEntry;
}

export function netEntry(id: number, har: HarEntry = harEntry(), content?: NetEntry['content']): NetEntry {
  return { id, har, contentState: content ? 'loaded' : 'empty', content };
}
