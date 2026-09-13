import type { Header, QueryString, Timings } from 'har-format';
import type { HarEntry } from '../panel/network/store';

/** The subset of Chrome DevTools Protocol `Network` types used here. */
type CdpHeaders = Record<string, string>;

interface CdpRequest {
  url: string;
  method: string;
  headers: CdpHeaders;
  postData?: string;
  hasPostData?: boolean;
  initialPriority?: string;
}

interface CdpTiming {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
}

interface CdpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: CdpHeaders;
  mimeType: string;
  remoteIPAddress?: string;
  remotePort?: number;
  encodedDataLength: number;
  timing?: CdpTiming;
  protocol?: string;
}

interface RequestWillBeSent {
  requestId: string;
  request: CdpRequest;
  timestamp: number;
  wallTime: number;
  initiator?: HarEntry['_initiator'];
  redirectResponse?: CdpResponse;
  type?: string;
}

interface Hop {
  request: CdpRequest;
  type?: string;
  initiator?: HarEntry['_initiator'];
  /** Monotonic seconds when the request was issued. */
  issueTime: number;
  wallTime: number;
  response?: CdpResponse;
  responseTime?: number;
  dataLength: number;
}

interface ExtraInfo {
  requestHeaders?: CdpHeaders;
  responseHeaders?: CdpHeaders;
  responseHeadersText?: string;
}

export interface FinishedRequest {
  requestId: string;
  har: HarEntry;
  /** `Network.getResponseBody` can be asked for this request. */
  hasBody: boolean;
  /** The request body was too large to be inlined; fetch it with `Network.getRequestPostData`. */
  needsPostData: boolean;
}

const TYPE_NAMES: Record<string, string> = {
  CSPViolationReport: 'csp-violation-report',
  SignedExchange: 'signed-exchange',
};

/**
 * Assembles HAR entries from `Network.*` events of a `chrome.debugger` session,
 * mirroring what `chrome.devtools.network.onRequestFinished` would deliver.
 * WebSockets are not reported.
 */
export class CdpNetworkRecorder {
  private readonly hops = new Map<string, Hop>();
  private readonly extra = new Map<string, ExtraInfo>();

  constructor(private readonly onFinished: (request: FinishedRequest) => void) {}

  reset(): void {
    this.hops.clear();
    this.extra.clear();
  }

  handle(method: string, params: unknown): void {
    const p = params as Record<string, any>;
    switch (method) {
      case 'Network.requestWillBeSent':
        return this.requestWillBeSent(p as RequestWillBeSent);
      case 'Network.requestWillBeSentExtraInfo':
        this.extraFor(p.requestId).requestHeaders = p.headers;
        return;
      case 'Network.responseReceived': {
        const hop = this.hops.get(p.requestId);
        if (!hop) return;
        hop.response = p.response;
        hop.responseTime = p.timestamp;
        hop.type ??= p.type;
        return;
      }
      case 'Network.responseReceivedExtraInfo': {
        const extra = this.extraFor(p.requestId);
        extra.responseHeaders = p.headers;
        extra.responseHeadersText = p.headersText;
        return;
      }
      case 'Network.dataReceived': {
        const hop = this.hops.get(p.requestId);
        if (hop) hop.dataLength += p.dataLength;
        return;
      }
      case 'Network.loadingFinished':
        return this.finish(p.requestId, p.timestamp, p.encodedDataLength);
      case 'Network.loadingFailed':
        return this.finish(p.requestId, p.timestamp, 0, p.errorText || 'net::ERR_FAILED');
    }
  }

  private requestWillBeSent(event: RequestWillBeSent): void {
    const previous = this.hops.get(event.requestId);
    if (previous && event.redirectResponse) {
      previous.response = event.redirectResponse;
      previous.responseTime = event.timestamp;
      this.finish(event.requestId, event.timestamp, event.redirectResponse.encodedDataLength, undefined, true);
    }
    this.hops.set(event.requestId, {
      request: event.request,
      type: event.type,
      initiator: event.initiator,
      issueTime: event.timestamp,
      wallTime: event.wallTime,
      dataLength: 0,
    });
  }

  private extraFor(requestId: string): ExtraInfo {
    let extra = this.extra.get(requestId);
    if (!extra) this.extra.set(requestId, (extra = {}));
    return extra;
  }

  private finish(requestId: string, endTime: number, encodedDataLength: number, error?: string, redirect = false): void {
    const hop = this.hops.get(requestId);
    if (!hop) return;
    this.hops.delete(requestId);
    const extra = this.extra.get(requestId) ?? {};
    this.extra.delete(requestId);
    if (hop.type === 'WebSocket') return;

    const har = buildEntry(hop, extra, endTime, encodedDataLength, error);
    const { request } = hop;
    this.onFinished({
      requestId,
      har,
      hasBody: !redirect && !error,
      needsPostData: !redirect && Boolean(request.hasPostData) && request.postData === undefined,
    });
  }
}

/** Adds a request body fetched separately with `Network.getRequestPostData`. */
export function withPostData(har: HarEntry, text: string): void {
  har.request.postData = { mimeType: headerValue(har.request.headers, 'content-type') ?? '', text };
  har.request.bodySize = text.length;
}

function buildEntry(hop: Hop, extra: ExtraInfo, endTime: number, encodedDataLength: number, error?: string): HarEntry {
  const { request, response } = hop;
  const timings = buildTimings(hop, endTime);
  let time = 0;
  // ssl is part of connect.
  for (const t of [timings.blocked, timings.dns, timings.connect, timings.send, timings.wait, timings.receive]) time += Math.max(t ?? 0, 0);

  const httpVersion = httpVersionOf(response?.protocol);
  const requestHeaders = toHeaderList(extra.requestHeaders ?? request.headers);
  const responseHeaders = toHeaderList(extra.responseHeaders ?? response?.headers ?? {});
  const headersSize = extra.responseHeadersText ? extra.responseHeadersText.length : -1;

  const har: HarEntry = {
    startedDateTime: new Date(hop.wallTime * 1000).toISOString(),
    time,
    _resourceType: resourceTypeName(hop.type) as HarEntry['_resourceType'],
    request: {
      method: request.method,
      url: request.url,
      httpVersion,
      cookies: [],
      headers: requestHeaders,
      queryString: queryStringOf(request.url),
      headersSize: -1,
      bodySize: request.postData?.length ?? 0,
    },
    response: {
      status: error ? 0 : (response?.status ?? 0),
      statusText: error ? '' : (response?.statusText ?? ''),
      httpVersion,
      cookies: [],
      headers: responseHeaders,
      content: { size: hop.dataLength, mimeType: response?.mimeType || 'x-unknown' },
      redirectURL: headerValue(responseHeaders, 'location') ?? '',
      headersSize,
      bodySize: response ? Math.max(encodedDataLength - Math.max(headersSize, 0), 0) : -1,
      _transferSize: encodedDataLength,
    },
    cache: {},
    timings,
  };
  if (hop.initiator) har._initiator = hop.initiator;
  if (request.initialPriority) har._priority = request.initialPriority;
  if (request.postData !== undefined) {
    har.request.postData = { mimeType: headerValue(requestHeaders, 'content-type') ?? '', text: request.postData };
  }
  if (response?.remoteIPAddress) har.serverIPAddress = response.remoteIPAddress.replace(/[[\]]/g, '');
  if (response?.remotePort !== undefined) har.connection = String(response.remotePort);
  if (error) (har.response as { _error?: string })._error = error;
  return har;
}

/** Same breakdown as Chrome's own HAR export (devtools-frontend `HAR.Log.Entry.buildTimings`). */
function buildTimings(hop: Hop, endTime: number): Timings {
  const timing = hop.response?.timing;
  const issueTime = hop.issueTime;
  const startTime = timing ? timing.requestTime : issueTime;
  const ms = (seconds: number) => (seconds === -1 ? -1 : seconds * 1000);

  const result: Timings = { blocked: -1, dns: -1, ssl: -1, connect: -1, send: 0, wait: 0, receive: 0 };
  result.blocked = ms(issueTime < startTime ? startTime - issueTime : -1);

  let highestTime = 0;
  if (timing) {
    const blockedStart = leastNonNegative([timing.dnsStart, timing.connectStart, timing.sendStart]);
    if (blockedStart !== Infinity) result.blocked! += blockedStart;
    if (timing.proxyEnd !== -1) result.blocked = Math.max(result.blocked!, timing.proxyEnd - timing.proxyStart);

    const dnsStart = timing.dnsEnd >= 0 ? blockedStart : 0;
    const dnsEnd = timing.dnsEnd >= 0 ? timing.dnsEnd : -1;
    result.dns = dnsEnd - dnsStart;

    const sslStart = timing.sslEnd > 0 ? timing.sslStart : 0;
    const sslEnd = timing.sslEnd > 0 ? timing.sslEnd : -1;
    result.ssl = sslEnd - sslStart;

    const connectStart = timing.connectEnd >= 0 ? leastNonNegative([dnsEnd, blockedStart]) : 0;
    const connectEnd = timing.connectEnd >= 0 ? timing.connectEnd : -1;
    result.connect = connectEnd - connectStart;

    const sendStart = timing.sendEnd >= 0 ? Math.max(connectEnd, dnsEnd, blockedStart) : 0;
    const sendEnd = timing.sendEnd >= 0 ? timing.sendEnd : 0;
    result.send = Math.max(sendEnd - sendStart, 0);
    highestTime = Math.max(sendEnd, connectEnd, sslEnd, dnsEnd, blockedStart, 0);
  } else if (hop.responseTime === undefined) {
    // Nothing is known after the request was issued, so it all counts as blocked.
    result.blocked = ms(endTime - issueTime);
    return result;
  }

  const waitEnd = ms((hop.responseTime ?? endTime) - startTime);
  result.wait = waitEnd - highestTime;
  result.receive = Math.max(ms(endTime - startTime) - waitEnd, 0);
  return result;
}

function leastNonNegative(values: number[]): number {
  return values.reduce((best, value) => (value >= 0 && value < best ? value : best), Infinity);
}

function resourceTypeName(type: string | undefined): string {
  if (!type) return 'other';
  return TYPE_NAMES[type] ?? type.toLowerCase();
}

function httpVersionOf(protocol: string | undefined): string {
  if (!protocol) return '';
  if (protocol === 'h2') return 'HTTP/2.0';
  if (protocol === 'h3') return 'HTTP/3.0';
  return protocol.toUpperCase();
}

/** CDP joins repeated headers (e.g. Set-Cookie) with newlines. */
function toHeaderList(headers: CdpHeaders): Header[] {
  const out: Header[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const part of String(value).split('\n')) out.push({ name, value: part });
  }
  return out;
}

function headerValue(headers: Header[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

function queryStringOf(url: string): QueryString[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}
