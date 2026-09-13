import { describe, expect, it } from 'vitest';
import { CdpNetworkRecorder, withPostData, type FinishedRequest } from '../src/shared/cdp-har';
import { resourceCategory, responseError, statusCategory } from '../src/panel/network/filter';

const T0 = 1000;
const WALL = Date.UTC(2026, 8, 13, 10, 0, 0) / 1000;

function recorder() {
  const finished: FinishedRequest[] = [];
  const rec = new CdpNetworkRecorder((request) => finished.push(request));
  return { finished, send: (method: string, params: Record<string, unknown>) => rec.handle(`Network.${method}`, params) };
}

const timing = { requestTime: T0 + 0.01, proxyStart: -1, proxyEnd: -1, dnsStart: 0, dnsEnd: 5, connectStart: 5, connectEnd: 20, sslStart: 10, sslEnd: 20, sendStart: 21, sendEnd: 22 };

function sent(requestId: string, request: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { requestId, request: { method: 'GET', headers: {}, ...request }, timestamp: T0, wallTime: WALL, type: 'Fetch', ...extra };
}

function response(url: string, extra: Record<string, unknown> = {}) {
  return { url, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, mimeType: 'application/json', encodedDataLength: 120, protocol: 'h2', timing, ...extra };
}

describe('CdpNetworkRecorder', () => {
  it('builds a fetch entry that the filters treat as Fetch/XHR', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'https://api.example.com/users?page=2', initialPriority: 'High' }, { initiator: { type: 'script' } }));
    send('responseReceived', { requestId: '1', timestamp: T0 + 0.1, type: 'Fetch', response: response('https://api.example.com/users?page=2', { remoteIPAddress: '[::1]', remotePort: 443 }) });
    send('dataReceived', { requestId: '1', dataLength: 17 });
    send('loadingFinished', { requestId: '1', timestamp: T0 + 0.15, encodedDataLength: 150 });

    expect(finished).toHaveLength(1);
    const { har, hasBody, needsPostData } = finished[0];
    expect({ hasBody, needsPostData }).toEqual({ hasBody: true, needsPostData: false });
    expect(resourceCategory(har)).toBe('fetch');
    expect(statusCategory(har)).toBe('2xx');
    expect(har).toMatchObject({
      startedDateTime: '2026-09-13T10:00:00.000Z',
      _resourceType: 'fetch',
      _priority: 'High',
      _initiator: { type: 'script' },
      serverIPAddress: '::1',
      connection: '443',
      request: { method: 'GET', httpVersion: 'HTTP/2.0', queryString: [{ name: 'page', value: '2' }], bodySize: 0 },
      response: { status: 200, content: { size: 17, mimeType: 'application/json' }, _transferSize: 150 },
    });
    expect(har.request.postData).toBeUndefined();
  });

  it('maps XHR and other CDP resource types to DevTools names', () => {
    const { finished, send } = recorder();
    const types = ['XHR', 'Document', 'Stylesheet', 'CSPViolationReport'];
    types.forEach((type, i) => {
      send('requestWillBeSent', sent(String(i), { url: `https://example.com/${i}` }, { type }));
      send('loadingFinished', { requestId: String(i), timestamp: T0 + 1, encodedDataLength: 0 });
    });
    expect(finished.map((f) => f.har._resourceType)).toEqual(['xhr', 'document', 'stylesheet', 'csp-violation-report']);
    expect(resourceCategory(finished[0].har)).toBe('fetch');
  });

  it('prefers raw headers from the ExtraInfo events', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'https://example.com/', headers: { Accept: '*/*' } }));
    send('requestWillBeSentExtraInfo', { requestId: '1', headers: { Accept: '*/*', Cookie: 'sid=abc' } });
    send('responseReceived', { requestId: '1', timestamp: T0 + 0.1, response: response('https://example.com/') });
    send('responseReceivedExtraInfo', { requestId: '1', headers: { 'set-cookie': 'a=1\nb=2' }, headersText: 'HTTP/1.1 200 OK\r\n\r\n' });
    send('loadingFinished', { requestId: '1', timestamp: T0 + 0.2, encodedDataLength: 50 });

    const { har } = finished[0];
    expect(har.request.headers).toEqual([
      { name: 'Accept', value: '*/*' },
      { name: 'Cookie', value: 'sid=abc' },
    ]);
    expect(har.response.headers).toEqual([
      { name: 'set-cookie', value: 'a=1' },
      { name: 'set-cookie', value: 'b=2' },
    ]);
    expect(har.response.headersSize).toBe(19);
    expect(har.response.bodySize).toBe(31);
  });

  it('keeps inline request bodies and flags large ones for fetching', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'https://example.com/a', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"a":1}', hasPostData: true }));
    send('loadingFinished', { requestId: '1', timestamp: T0 + 1, encodedDataLength: 0 });
    send('requestWillBeSent', sent('2', { url: 'https://example.com/b', method: 'POST', headers: { 'Content-Type': 'text/plain' }, hasPostData: true }));
    send('loadingFinished', { requestId: '2', timestamp: T0 + 1, encodedDataLength: 0 });

    expect(finished[0].har.request.postData).toEqual({ mimeType: 'application/json', text: '{"a":1}' });
    expect(finished[0].har.request.bodySize).toBe(7);
    expect(finished[1].needsPostData).toBe(true);
    withPostData(finished[1].har, 'big body');
    expect(finished[1].har.request.postData).toEqual({ mimeType: 'text/plain', text: 'big body' });
  });

  it('reports each redirect hop as its own entry', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'https://example.com/old' }, { type: 'Document' }));
    send('requestWillBeSent', {
      ...sent('1', { url: 'https://example.com/new' }, { type: 'Document' }),
      timestamp: T0 + 0.05,
      redirectResponse: response('https://example.com/old', { status: 302, statusText: 'Found', headers: { Location: '/new' } }),
    });
    send('responseReceived', { requestId: '1', timestamp: T0 + 0.1, response: response('https://example.com/new') });
    send('loadingFinished', { requestId: '1', timestamp: T0 + 0.2, encodedDataLength: 10 });

    expect(finished.map((f) => [f.har.request.url, f.har.response.status, f.hasBody])).toEqual([
      ['https://example.com/old', 302, false],
      ['https://example.com/new', 200, true],
    ]);
    expect(finished[0].har.response.redirectURL).toBe('/new');
  });

  it('marks failed requests like Chrome does', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'https://example.com/down' }));
    send('loadingFailed', { requestId: '1', timestamp: T0 + 0.5, errorText: 'net::ERR_CONNECTION_REFUSED' });

    const { har, hasBody } = finished[0];
    expect(hasBody).toBe(false);
    expect(statusCategory(har)).toBe('failed');
    expect(responseError(har)).toBe('net::ERR_CONNECTION_REFUSED');
    expect(har.timings.blocked).toBe(500);
    expect(har.time).toBe(500);
  });

  it('splits the time into phases from the response timing', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'https://example.com/' }));
    send('responseReceived', { requestId: '1', timestamp: T0 + 0.11, response: response('https://example.com/') });
    send('loadingFinished', { requestId: '1', timestamp: T0 + 0.15, encodedDataLength: 10 });

    const { timings, time } = finished[0].har;
    expect(timings.blocked).toBeCloseTo(10);
    expect(timings.dns).toBe(5);
    expect(timings.connect).toBe(20);
    expect(timings.ssl).toBe(10);
    expect(timings.send).toBe(2);
    expect(timings.wait).toBeCloseTo(78);
    expect(timings.receive).toBeCloseTo(40);
    expect(time).toBeCloseTo(155);
  });

  it('ignores WebSockets and events for unknown requests', () => {
    const { finished, send } = recorder();
    send('requestWillBeSent', sent('1', { url: 'wss://example.com/socket' }, { type: 'WebSocket' }));
    send('loadingFinished', { requestId: '1', timestamp: T0 + 1, encodedDataLength: 0 });
    send('loadingFinished', { requestId: 'unknown', timestamp: T0 + 1, encodedDataLength: 0 });
    expect(finished).toHaveLength(0);
  });
});
