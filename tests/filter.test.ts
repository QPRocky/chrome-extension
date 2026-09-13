import { describe, expect, it } from 'vitest';
import { compileFilter, emptyFilter, resourceCategory, statusCategory } from '../src/panel/network/filter';
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
