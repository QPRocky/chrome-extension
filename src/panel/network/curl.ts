import type { HarEntry } from './store';

const SKIP_ALWAYS = new Set(['content-length', 'host', 'connection']);
// Headers a page script is not allowed to set with fetch().
const FORBIDDEN_FOR_FETCH = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function requestHeaders(har: HarEntry) {
  return har.request.headers.filter(({ name }) => !name.startsWith(':') && !SKIP_ALWAYS.has(name.toLowerCase()));
}

export function toCurl(har: HarEntry): string {
  const { request } = har;
  const parts = [`curl ${shellQuote(request.url)}`];
  const body = request.postData?.text;
  const method = request.method.toUpperCase();
  if (method !== 'GET' || body !== undefined) {
    if (!(method === 'POST' && body !== undefined)) parts.push(`-X ${method}`);
  }
  let compressed = false;
  for (const { name, value } of requestHeaders(har)) {
    if (name.toLowerCase() === 'accept-encoding') {
      compressed = true;
      continue;
    }
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }
  if (body !== undefined) parts.push(`--data-raw ${shellQuote(body)}`);
  if (compressed) parts.push('--compressed');
  return parts.join(' \\\n  ');
}

export function toFetch(har: HarEntry): string {
  const { request } = har;
  const headers: Record<string, string> = {};
  let referrer: string | undefined;
  let hasCookie = false;
  for (const { name, value } of requestHeaders(har)) {
    const key = name.toLowerCase();
    if (key === 'referer') referrer = value;
    if (key === 'cookie') hasCookie = true;
    if (FORBIDDEN_FOR_FETCH.has(key) || key.startsWith('sec-') || key.startsWith('proxy-')) continue;
    headers[name] = value;
  }

  const init: Record<string, unknown> = { method: request.method.toUpperCase(), headers };
  if (request.postData?.text !== undefined) init.body = request.postData.text;
  if (referrer) init.referrer = referrer;
  init.credentials = hasCookie ? 'include' : 'omit';

  return `fetch(${JSON.stringify(request.url)}, ${JSON.stringify(init, null, 2)});`;
}
