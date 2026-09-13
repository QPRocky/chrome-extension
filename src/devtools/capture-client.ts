import type { NetworkStore } from '../panel/network/store';
import { CAPTURE_PORT_PREFIX, SOURCE, isEnvelope, type CaptureCommand, type CaptureEvent, type Envelope } from '../shared/messages';

const RECONNECT_MS = 250;

/**
 * Keeps a Full capture session running in the background service worker while
 * `store.settings.fullCapture` is on.
 *
 * Needed because Chrome withholds requests from `chrome.devtools.network` when
 * their initiator stack references a URL the extension may not access, such as
 * another extension's script. With Redux DevTools installed that covers every
 * fetch started from a Redux thunk.
 */
export class CaptureClient {
  private port: chrome.runtime.Port | null = null;
  private startedWith: number | null = null;

  constructor(
    private readonly store: NetworkStore,
    private readonly tabId: number,
  ) {}

  start(): void {
    this.store.subscribe((event) => {
      if (event.type === 'settings') this.sync();
    });
    this.sync();
  }

  private sync(): void {
    const { fullCapture, maxBodyMB } = this.store.settings;
    if (!fullCapture) {
      this.disconnect();
      return;
    }
    if (!this.port) {
      try {
        this.connect();
      } catch {
        // The extension was reloaded; this DevTools page is orphaned.
        return;
      }
    }
    if (this.startedWith !== maxBodyMB) {
      this.startedWith = maxBodyMB;
      this.post({ kind: 'start', maxBodyMB });
    }
  }

  private connect(): void {
    const port = chrome.runtime.connect({ name: `${CAPTURE_PORT_PREFIX}${this.tabId}` });
    this.port = port;
    this.startedWith = null;
    port.onMessage.addListener((message: unknown) => {
      if (isEnvelope(message)) this.receive(message.payload as CaptureEvent);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      // The service worker was probably restarted; resume if still wanted.
      setTimeout(() => this.sync(), RECONNECT_MS);
    });
  }

  private disconnect(): void {
    const port = this.port;
    this.port = null;
    this.startedWith = null;
    port?.disconnect();
  }

  private receive(event: CaptureEvent): void {
    switch (event.kind) {
      case 'entry':
        this.store.addCaptured(event.har, event.contentState, event.content);
        break;
      case 'detached':
        this.store.failCapture(event.reason === 'canceled_by_user' ? 'Full capture was stopped from the browser debugging bar.' : `Full capture stopped (${event.reason}).`);
        break;
      case 'error':
        this.store.failCapture(event.message);
        break;
    }
  }

  private post(command: CaptureCommand): void {
    const envelope: Envelope<CaptureCommand> = { source: SOURCE, payload: command };
    try {
      this.port?.postMessage(envelope);
    } catch {
      // disconnected; onDisconnect resyncs
    }
  }
}
