import type { HarEntry, NetEntry } from './store';

export type TypeFilter = 'all' | 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'media' | 'ws' | 'other';
export type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'failed';

export interface NetFilter {
  /** Space separated terms matched against the URL; `-term` excludes, `/re/i` is a regex. */
  text: string;
  /** Same syntax as `text`, matched against text response bodies. */
  body: string;
  method: string;
  type: TypeFilter;
  status: StatusFilter;
}

export const emptyFilter: NetFilter = { text: '', body: '', method: '', type: 'all', status: 'all' };

export interface CompiledFilter {
  test(entry: NetEntry): boolean;
  error?: string;
  bodyError?: string;
  /** Visibility depends on response bodies, which load after the entry is added. */
  searchesBody: boolean;
}

export interface TextMatcher {
  test(haystack: string): boolean;
  error?: string;
}

const REGEX_QUERY = /^\/(.+)\/([a-z]*)$/;

/**
 * Space separated terms that must all match case-insensitively; `-term`
 * excludes, `/re/i` is a regex. Returns null for an empty query. Uses regexes
 * rather than `toLowerCase()` so large bodies are not copied on every test.
 */
export function compileText(query: string): TextMatcher | null {
  const text = query.trim();
  if (!text) return null;
  const regex = REGEX_QUERY.exec(text);
  if (regex) {
    try {
      // Stateful flags would make repeated test() calls skip matches.
      const re = new RegExp(regex[1], regex[2].replace(/[gy]/g, ''));
      return { test: (haystack) => re.test(haystack) };
    } catch (err) {
      return { test: () => true, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const terms = text.split(/\s+/).map((term) => {
    const exclude = term.startsWith('-') && term.length > 1;
    return { exclude, re: new RegExp(escapeRegExp(exclude ? term.slice(1) : term), 'i') };
  });
  return { test: (haystack) => terms.every(({ exclude, re }) => re.test(haystack) !== exclude) };
}

/** First plain term of a query, used to highlight matches in the response tree. */
export function highlightTerm(query: string): string {
  const text = query.trim();
  if (REGEX_QUERY.test(text)) return '';
  return text.split(/\s+/).find((term) => term && !(term.startsWith('-') && term.length > 1)) ?? '';
}

export function compileFilter(filter: NetFilter): CompiledFilter {
  const predicates: ((entry: NetEntry) => boolean)[] = [];

  const url = compileText(filter.text);
  if (url && !url.error) predicates.push((entry) => url.test(entry.har.request.url));

  const body = compileText(filter.body);
  if (body && !body.error) {
    predicates.push(({ contentState, content }) => contentState === 'loaded' && !!content && content.encoding !== 'base64' && body.test(content.text));
  }

  if (filter.method) {
    const method = filter.method.toUpperCase();
    predicates.push((entry) => entry.har.request.method.toUpperCase() === method);
  }
  if (filter.type !== 'all') predicates.push((entry) => resourceCategory(entry.har) === filter.type);
  if (filter.status !== 'all') predicates.push((entry) => statusCategory(entry.har) === filter.status);

  return {
    test: (entry) => predicates.every((p) => p(entry)),
    error: url?.error,
    bodyError: body?.error,
    searchesBody: Boolean(body && !body.error),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
