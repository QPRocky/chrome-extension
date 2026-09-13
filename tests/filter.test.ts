import { describe, expect, it } from 'vitest';
import { compileFilter, emptyFilter, highlightTerm, resourceCategory, statusCategory } from '../src/panel/network/filter';
import type { NetEntry } from '../src/panel/network/store';
import { harEntry, netEntry } from './fixtures';

const api = netEntry(1, harEntry({ request: { url: 'https://api.example.com/users' } }));
const script = netEntry(2, harEntry({ _resourceType: 'script', request: { url: 'https://cdn.example.com/app.js' } }));
const failed = netEntry(3, harEntry({ request: { method: 'POST', url: 'https://api.example.com/login' }, response: { status: 401 } }));

const run = (patch: Partial<typeof emptyFilter>) => {
  const filter = compileFilter({ ...emptyFilter, ...patch });
  return [api, script, failed].filter((e) => filter.test(e)).map((e) => e.id);
};

describe('compileFilter', () => {
  it('matches every term case-insensitively', () => {
    expect(run({ text: 'API users' })).toEqual([1]);
    expect(run({ text: 'example' })).toEqual([1, 2, 3]);
  });

  it('excludes terms prefixed with a dash', () => {
    expect(run({ text: 'example -cdn' })).toEqual([1, 3]);
  });

  it('supports regular expressions', () => {
    expect(run({ text: '/\\/(users|login)$/' })).toEqual([1, 3]);
    const invalid = compileFilter({ ...emptyFilter, text: '/(/' });
    expect(invalid.error).toBeTruthy();
    expect(invalid.test(api)).toBe(true);
  });

  it('filters by method, type and status', () => {
    expect(run({ method: 'post' })).toEqual([3]);
    expect(run({ type: 'js' })).toEqual([2]);
    expect(run({ type: 'fetch', status: '4xx' })).toEqual([3]);
  });
});

describe('response body search', () => {
  const users = netEntry(1, harEntry(), { text: '{"users":[{"id":42,"name":"Matti","active":true}]}' });
  const error = netEntry(2, harEntry({ request: { url: 'https://api.example.com/login' } }), { text: '{"error":"Unauthorized","id":7}' });
  const pending: NetEntry = { id: 3, har: harEntry(), contentState: 'pending' };
  const empty = netEntry(4);
  const binary = netEntry(5, harEntry({ response: { content: { mimeType: 'image/png' } } }), { text: 'aWQ=', encoding: 'base64' });
  const all = [users, error, pending, empty, binary];

  const search = (patch: Partial<typeof emptyFilter>) => {
    const filter = compileFilter({ ...emptyFilter, ...patch });
    return all.filter((e) => filter.test(e)).map((e) => e.id);
  };

  it('matches every term case-insensitively', () => {
    expect(search({ body: 'matti' })).toEqual([1]);
    expect(search({ body: '"id": ACTIVE' })).toEqual([1]);
    expect(search({ body: '"id"' })).toEqual([1, 2]);
    expect(search({ body: 'nothing-here' })).toEqual([]);
  });

  it('excludes terms prefixed with a dash', () => {
    expect(search({ body: '"id" -error' })).toEqual([1]);
  });

  it('supports regular expressions', () => {
    expect(search({ body: '/"id":\\s*\\d{2}/' })).toEqual([1]);
    expect(search({ body: '/UNAUTHORIZED/gi' })).toEqual([2]);
  });

  it('reports an invalid regex separately from the URL filter', () => {
    const invalid = compileFilter({ ...emptyFilter, body: '/(/' });
    expect(invalid.bodyError).toBeTruthy();
    expect(invalid.error).toBeUndefined();
    expect(invalid.searchesBody).toBe(false);
    expect(all.every((e) => invalid.test(e))).toBe(true);
  });

  it('hides requests without a text body only while searching', () => {
    expect(search({})).toEqual([1, 2, 3, 4, 5]);
    expect(search({ body: '-nothing-here' })).toEqual([1, 2]);
    expect(compileFilter({ ...emptyFilter, body: 'id' }).searchesBody).toBe(true);
    expect(compileFilter({ ...emptyFilter, body: '  ' }).searchesBody).toBe(false);
  });

  it('combines with the URL filter', () => {
    expect(search({ text: 'login', body: '"id"' })).toEqual([2]);
  });
});

describe('highlightTerm', () => {
  it('returns the first plain term', () => {
    expect(highlightTerm('-error matti active')).toBe('matti');
    expect(highlightTerm('/matti/i')).toBe('');
    expect(highlightTerm('')).toBe('');
  });
});

describe('categories', () => {
  it('falls back to the mime type when the resource type is missing', () => {
    expect(resourceCategory(harEntry({ _resourceType: undefined, response: { content: { mimeType: 'text/html' } } }))).toBe('doc');
    expect(resourceCategory(harEntry({ _resourceType: 'xhr' }))).toBe('fetch');
    expect(resourceCategory(harEntry({ _resourceType: 'font' }))).toBe('other');
  });

  it('treats status 0 and Chrome errors as failed', () => {
    expect(statusCategory(harEntry({ response: { status: 0 } }))).toBe('failed');
    expect(statusCategory(harEntry({ response: { status: 200, _error: 'net::ERR_ABORTED' } as never }))).toBe('failed');
    expect(statusCategory(harEntry({ response: { status: 302 } }))).toBe('3xx');
  });
});
