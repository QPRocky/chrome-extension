import {
  SOURCE,
  isEnvelope,
  type Envelope,
  type PageEvent,
  type PanelInbound,
  type PanelOutbound,
  type RequestMap,
  type RequestMethod,
} from '../../shared/messages';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class PageUnavailableError extends Error {}

const TIMEOUT_MS = 10_000;
const PING_MS = 20_000;

/** Talks to the page hook through the background service worker. */
export class ReduxClient {
  private port: chrome.runtime.Port | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: PageEvent) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly tabId: number) {}

  connect(): void {
    const port = chrome.runtime.connect({ name: `panel:${this.tabId}` });
    this.port = port;
    port.onMessage.addListener((message: unknown) => {
      if (isEnvelope(message)) this.receive(message.payload as PanelInbound);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      clearInterval(this.pingTimer);
      this.rejectAll(new PageUnavailableError('Connection to the extension was lost'));
      // The service worker was probably restarted; reconnect and let the view resync.
      setTimeout(() => {
        this.connect();
        for (const listener of this.reconnectListeners) listener();
      }, 250);
    });
    // Keeps the service worker alive while the panel is open.
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.post({ kind: 'ping' }), PING_MS);
  }

  onEvent(listener: (event: PageEvent) => void): void {
    this.listeners.add(listener);
  }

  onReconnect(listener: () => void): void {
    this.reconnectListeners.add(listener);
  }

  request<M extends RequestMethod>(method: M, params: RequestMap[M]['params']): Promise<RequestMap[M]['result']> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PageUnavailableError(`Page did not respond to "${method}"`));
      }, TIMEOUT_MS);
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.post({ kind: 'request', requestId, method, params });
    });
  }

  private post(payload: PanelOutbound): void {
    if (!this.port) this.connect();
    const envelope: Envelope<PanelOutbound> = { source: SOURCE, payload };
    this.port!.postMessage(envelope);
  }

  private receive(message: PanelInbound): void {
    if (message.kind === 'page-unavailable') {
      if (message.requestId !== undefined) this.settle(message.requestId, new PageUnavailableError(message.error));
      return;
    }
    if (message.kind === 'response') {
      this.settle(message.requestId, message.ok ? undefined : new Error(message.error), message.ok ? message.result : undefined);
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private settle(requestId: number, error: Error | undefined, result?: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
