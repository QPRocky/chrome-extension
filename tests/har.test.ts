import { describe, expect, it } from 'vitest';
import { buildHar, buildSimpleJson, headersToRecord, suggestedName } from '../src/panel/network/har';
import { harEntry, netEntry } from './fixtures';

describe('buildHar', () => {
  const json = netEntry(1, harEntry(), { text: '{"users":[1,2]}' });
  const image = netEntry(
    2,
    harEntry({ _resourceType: 'image', response: { content: { mimeType: 'image/png', size: 3 } } }),
    { text: 'iVBO', encoding: 'base64' },
  );

  it('produces a HAR 1.2 log with bodies and encodings', () => {
    const har = buildHar([json, image], { includeBodies: true, creatorVersion: '1.2.3' });
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'DevKit', version: '1.2.3' });
    expect(har.log.pages).toEqual([]);
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0].response.content.text).toBe('{"users":[1,2]}');
    expect(har.log.entries[0].response.content.encoding).toBeUndefined();
    expect(har.log.entries[1].response.content).toMatchObject({ text: 'iVBO', encoding: 'base64', mimeType: 'image/png' });
  });

  it('drops pagerefs because pages are not exported', () => {
    const har = buildHar([json], { includeBodies: true });
    expect(har.log.entries[0]).not.toHaveProperty('pageref');
  });

  it('omits bodies when asked to', () => {
    const har = buildHar([json], { includeBodies: false });
    expect(har.log.entries[0].response.content).toEqual({ size: 17, mimeType: 'application/json' });
  });

  it('does not mutate the recorded entries', () => {
    buildHar([json], { includeBodies: true });
    expect(json.har.response.content.text).toBeUndefined();
    expect(json.har.pageref).toBe('page_1');
  });
});

describe('buildSimpleJson', () => {
  it('parses JSON bodies and flattens headers', () => {
    const entry = netEntry(
      1,
      harEntry({ request: { method: 'POST', postData: { mimeType: 'application/json', text: '{"name":"Ann"}' } } }),
      { text: '{"id":7}' },
    );
    const [out] = buildSimpleJson([entry], { includeBodies: true });
    expect(out).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/users?page=2',
      status: 200,
      type: 'fetch',
      durationMs: 43,
      requestBody: { name: 'Ann' },
      responseBody: { id: 7 },
      requestHeaders: { accept: 'application/json', cookie: 'sid=abc' },
    });
  });

  it('keeps invalid JSON and binary bodies as text', () => {
    const broken = netEntry(1, harEntry(), { text: '{nope' });
    const binary = netEntry(2, harEntry(), { text: 'AAAA', encoding: 'base64' });
    const [a, b] = buildSimpleJson([broken, binary], { includeBodies: true });
    expect(a.responseBody).toBe('{nope');
    expect(b.responseBody).toBeUndefined();
    expect(b.responseBodyBase64).toBe('AAAA');
  });

  it('reports Chrome network errors', () => {
    const failed = netEntry(1, harEntry({ response: { status: 0, _error: 'net::ERR_FAILED' } as never }));
    expect(buildSimpleJson([failed], { includeBodies: false })[0].error).toBe('net::ERR_FAILED');
  });
});

describe('helpers', () => {
  it('joins repeated headers', () => {
    expect(
      headersToRecord([
        { name: 'Set-Cookie', value: 'a=1' },
        { name: 'set-cookie', value: 'b=2' },
        { name: 'Vary', value: 'Accept' },
        { name: 'vary', value: 'Origin' },
      ]),
    ).toEqual({ 'set-cookie': 'a=1\nb=2', vary: 'Accept, Origin' });
  });

  it('suggests a file name from the document host', () => {
    const doc = netEntry(1, harEntry({ _resourceType: 'document', request: { url: 'https://app.example.com:8080/' } }));
    expect(suggestedName([netEntry(2), doc], 'har', '20260913-100000')).toBe('network-app.example.com_8080-20260913-100000.har');
  });
});
