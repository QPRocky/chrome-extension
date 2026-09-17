// Runs in the page's MAIN world at document_start, before any app script.
import { SOURCE, isFormMethod, isWindowEnvelope, type PageEvent, type PageRequest, type WindowEnvelope } from '../shared/messages';
import { FormHandlers } from './forms';
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

  const forms = new FormHandlers(registry);

  try {
    installReduxGlobals(win, registry);
  } catch (err) {
    console.warn('[devkit] Could not install Redux DevTools hook, falling back to React tree scanning.', err);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !isWindowEnvelope(event.data, 'to-page')) return;
    const request = event.data.payload as PageRequest;
    if (request?.kind !== 'request') return;
    const fail = (err: unknown) =>
      post({
        kind: 'response',
        requestId: request.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    try {
      // Form filling runs in several passes, so a handler may answer with a promise.
      const result = isFormMethod(request.method) ? forms.handle(request.method, request.params) : registry.handle(request.method, request.params as never);
      void Promise.resolve(result).then(
        (value) => post({ kind: 'response', requestId: request.requestId, ok: true, result: value }),
        fail,
      );
    } catch (err) {
      fail(err);
    }
  });
}
