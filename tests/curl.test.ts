import { describe, expect, it } from 'vitest';
import { toCurl, toFetch } from '../src/panel/network/curl';
import { harEntry } from './fixtures';

const post = harEntry({
  request: {
    method: 'POST',
    url: 'https://api.example.com/items',
    headers: [
      { name: ':authority', value: 'api.example.com' },
      { name: 'content-type', value: 'application/json' },
      { name: 'content-length', value: '20' },
      { name: 'accept-encoding', value: 'gzip' },
      { name: 'cookie', value: 'sid=abc' },
      { name: 'referer', value: 'https://app.example.com/' },
      { name: 'sec-fetch-mode', value: 'cors' },
    ],
    postData: { mimeType: 'application/json', text: `{"name":"it's"}` },
  },
});

describe('toCurl', () => {
  it('quotes values safely and skips pseudo headers', () => {
    const curl = toCurl(post);
    expect(curl).toBe(
      [
        `curl 'https://api.example.com/items'`,
        `-H 'content-type: application/json'`,
        `-H 'cookie: sid=abc'`,
        `-H 'referer: https://app.example.com/'`,
        `-H 'sec-fetch-mode: cors'`,
        `--data-raw '{"name":"it'\\''s"}'`,
        '--compressed',
      ].join(' \\\n  '),
    );
  });

  it('adds -X for methods curl cannot infer', () => {
    expect(toCurl(harEntry({ request: { method: 'DELETE', headers: [] } }))).toContain('-X DELETE');
    expect(toCurl(harEntry({ request: { headers: [] } }))).not.toContain('-X');
  });
});

describe('toFetch', () => {
  it('produces a fetch call without forbidden headers', () => {
    const code = toFetch(post);
    const match = /^fetch\((".*?"), ([\s\S]*)\);$/.exec(code)!;
    expect(JSON.parse(match[1])).toBe('https://api.example.com/items');
    expect(JSON.parse(match[2])).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"name":"it's"}`,
      referrer: 'https://app.example.com/',
      credentials: 'include',
    });
  });
});
