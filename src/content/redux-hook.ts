// Runs in the page's MAIN world at document_start, before any app script.
import { SOURCE, isWindowEnvelope, type PageEvent, type PageRequest, type WindowEnvelope } from '../shared/messages';
import { installReduxGlobals } from './redux/enhancer';
import { findStoresInReactTree } from './redux/fiber';
import { Registry } from './redux/registry';

const GUARD = '__DEVKIT_REDUX_HOOK__';
const win = window as unknown as Record<string, unknown>;

if (!win[GUARD]) {
  win[GUARD] = true;

  const post = (payload: PageEvent) => {
    const envelope: WindowEnvelope<PageEvent> = { source: SOURCE, dir: 'to-panel', payload };
    window.postMessage(envelope, '*');
  };

  const registry = new Registry({
    emit: post,
    scan: () => findStoresInReactTree(document),
  });

  try {
    installReduxGlobals(win, registry);
  } catch (err) {
    console.warn('[devkit] Could not install Redux DevTools hook, falling back to React tree scanning.', err);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !isWindowEnvelope(event.data, 'to-page')) return;
    const request = event.data.payload as PageRequest;
    if (request?.kind !== 'request') return;
    try {
      const result = registry.handle(request.method, request.params as never);
      post({ kind: 'response', requestId: request.requestId, ok: true, result });
    } catch (err) {
      post({
        kind: 'response',
        requestId: request.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
