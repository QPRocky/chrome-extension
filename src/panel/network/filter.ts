import type { HarEntry, NetEntry } from './store';

export type TypeFilter = 'all' | 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'media' | 'ws' | 'other';
export type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed';

export interface NetFilter {
  /** Space separated terms matched against the URL; `-term` excludes, `/re/i` is a regex. */
  text: string;
  method: string;
  type: TypeFilter;
  status: StatusFilter;
}

export const emptyFilter: NetFilter = { text: '', method: '', type: 'all', status: 'all' };

export interface CompiledFilter {
  test(entry: NetEntry): boolean;
  error?: string;
}

export function compileFilter(filter: NetFilter): CompiledFilter {
  const predicates: ((har: HarEntry) => boolean)[] = [];
  let error: string | undefined;

  const text = filter.text.trim();
  const regex = /^\/(.+)\/([a-z]*)$/.exec(text);
  if (regex) {
    try {
      const re = new RegExp(regex[1], regex[2]);
      predicates.push((har) => re.test(har.request.url));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else if (text) {
    for (const term of text.split(/\s+/)) {
      if (term.startsWith('-') && term.length > 1) {
        const needle = term.slice(1).toLowerCase();
        predicates.push((har) => !har.request.url.toLowerCase().includes(needle));
      } else {
        const needle = term.toLowerCase();
        predicates.push((har) => har.request.url.toLowerCase().includes(needle));
      }
    }
  }

  if (filter.method) {
    const method = filter.method.toUpperCase();
    predicates.push((har) => har.request.method.toUpperCase() === method);
  }
  if (filter.type !== 'all') predicates.push((har) => resourceCategory(har) === filter.type);
  if (filter.status !== 'all') predicates.push((har) => statusCategory(har) === filter.status);

  return { test: (entry) => predicates.every((p) => p(entry.har)), error };
}

export function resourceCategory(har: HarEntry): Exclude<TypeFilter, 'all'> {
  const type = har._resourceType;
  switch (type) {
    case 'fetch':
    case 'xhr':
      return 'fetch';
    case 'document':
      return 'doc';
    case 'script':
      return 'js';
    case 'stylesheet':
      return 'css';
    case 'image':
      return 'img';
    case 'media':
      return 'media';
    case 'websocket':
      return 'ws';
  }
  if (type) return 'other';

  const mime = har.response.content.mimeType?.toLowerCase() ?? '';
  if (mime.includes('html')) return 'doc';
  if (mime.includes('javascript')) return 'js';
  if (mime.includes('css')) return 'css';
  if (mime.startsWith('image/')) return 'img';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (mime.includes('json')) return 'fetch';
  return 'other';
}

export function statusCategory(har: HarEntry): Exclude<StatusFilter, 'all'> {
  const status = har.response.status;
  if (!status || responseError(har)) return 'failed';
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  if (status < 500) return '4xx';
  return '5xx';
}

/** Chrome adds a non-standard `_error` (e.g. net::ERR_FAILED) to failed responses. */
export function responseError(har: HarEntry): string | undefined {
  const error = (har.response as { _error?: unknown })._error;
  return error ? String(error) : undefined;
}
