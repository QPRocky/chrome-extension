import type { Har, Header } from 'har-format';
import { responseError } from './filter';
import type { HarEntry, NetEntry } from './store';

export interface ExportOptions {
  includeBodies: boolean;
  creatorVersion?: string;
}

/** Builds a HAR 1.2 log that Chrome's Network panel can import. */
export function buildHar(entries: NetEntry[], options: ExportOptions): Har {
  return {
    log: {
      version: '1.2',
      creator: { name: 'DevKit', version: options.creatorVersion ?? '0.1.0' },
      pages: [],
      entries: entries.map((entry) => {
        const { pageref: _pageref, ...har } = entry.har;
        const content = { ...har.response.content };
        delete content.text;
        delete content.encoding;
        if (options.includeBodies && entry.content) {
          content.text = entry.content.text;
          if (entry.content.encoding) content.encoding = entry.content.encoding;
        }
        return { ...har, response: { ...har.response, content } };
      }),
    },
  };
}

export interface SimpleRequest {
  method: string;
  url: string;
  status: number;
  statusText: string;
  type: string | undefined;
  startedDateTime: string;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  responseBodyBase64?: string;
  responseMimeType: string;
  responseSize: number;
  error?: string;
}

/** A compact JSON representation, with JSON bodies parsed into objects. */
export function buildSimpleJson(entries: NetEntry[], options: ExportOptions): SimpleRequest[] {
  return entries.map(({ har, content }) => {
    const out: SimpleRequest = {
      method: har.request.method,
      url: har.request.url,
      status: har.response.status,
      statusText: har.response.statusText,
      type: har._resourceType ?? undefined,
      startedDateTime: har.startedDateTime,
      durationMs: Math.round(har.time),
      requestHeaders: headersToRecord(har.request.headers),
      responseHeaders: headersToRecord(har.response.headers),
      responseMimeType: har.response.content.mimeType,
      responseSize: har.response.content.size,
    };
    const error = responseError(har);
    if (error) out.error = error;
    if (!options.includeBodies) return out;

    const postData = har.request.postData;
    if (postData?.text !== undefined) out.requestBody = maybeParseJson(postData.text, postData.mimeType);
    else if (postData?.params) out.requestBody = postData.params;

    if (content?.encoding === 'base64') out.responseBodyBase64 = content.text;
    else if (content) out.responseBody = maybeParseJson(content.text, har.response.content.mimeType);
    return out;
  });
}

export function headersToRecord(headers: Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of headers) {
    const key = name.toLowerCase();
    if (key in out) out[key] += key === 'set-cookie' ? `\n${value}` : `, ${value}`;
    else out[key] = value;
  }
  return out;
}

export function isJsonMime(mimeType: string | undefined): boolean {
  return !!mimeType && /[/+]json\b/i.test(mimeType);
}

export function maybeParseJson(text: string, mimeType?: string): unknown {
  const trimmed = text.trimStart();
  if (!isJsonMime(mimeType) && !(trimmed.startsWith('{') || trimmed.startsWith('['))) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function suggestedName(entries: NetEntry[], extension: string, stamp: string): string {
  const doc = entries.find((e) => e.har._resourceType === 'document') ?? entries[0];
  let host = 'network';
  try {
    if (doc) host = new URL(doc.har.request.url).host;
  } catch {
    // keep default
  }
  return `network-${host.replace(/[^\w.-]+/g, '_')}-${stamp}.${extension}`;
}

export function entryUrlName(har: HarEntry): string {
  try {
    const url = new URL(har.request.url);
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url.host;
  } catch {
    return har.request.url;
  }
}
