import { SOURCE, isEnvelope, type Envelope, type PanelOutbound, type RelayEvent } from '../shared/messages';

const PANEL_PREFIX = 'panel:';
const panels = new Map<number, chrome.runtime.Port>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(PANEL_PREFIX)) return;
  const tabId = Number(port.name.slice(PANEL_PREFIX.length));
  if (!Number.isInteger(tabId)) return;

  panels.set(tabId, port);

  port.onMessage.addListener((message: unknown) => {
    if (!isEnvelope(message)) return;
    const payload = message.payload as PanelOutbound;
    if (payload.kind === 'ping') return;

    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch((err: unknown) => {
      const event: Envelope<RelayEvent> = {
        source: SOURCE,
        payload: {
          kind: 'page-unavailable',
          requestId: payload.requestId,
          error: err instanceof Error ? err.message : String(err),
        },
      };
      port.postMessage(event);
    });
  });

  port.onDisconnect.addListener(() => {
    if (panels.get(tabId) === port) panels.delete(tabId);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !isEnvelope(message)) return;
  const port = panels.get(tabId);
  port?.postMessage(message);
  sendResponse({ delivered: Boolean(port) });
});
