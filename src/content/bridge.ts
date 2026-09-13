// Isolated-world content script relaying messages between the page hook and the extension.
import { SOURCE, isEnvelope, isWindowEnvelope, type WindowEnvelope } from '../shared/messages';

// Page events are only forwarded while a DevTools panel is listening, so pages
// without an open panel never wake the service worker.
let attached = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || !isEnvelope(message)) return;
  attached = true;
  const envelope: WindowEnvelope<unknown> = { source: SOURCE, dir: 'to-page', payload: message.payload };
  window.postMessage(envelope, '*');
  // Acknowledge delivery; the actual response arrives as a separate page event.
  sendResponse({ received: true });
});

window.addEventListener('message', (event) => {
  if (!attached || event.source !== window || !isWindowEnvelope(event.data, 'to-panel')) return;
  try {
    chrome.runtime
      .sendMessage({ source: SOURCE, payload: event.data.payload })
      .then((response: { delivered?: boolean } | undefined) => {
        if (!response?.delivered) attached = false;
      })
      .catch(() => {
        attached = false;
      });
  } catch {
    // Extension was reloaded and this content script is orphaned.
    attached = false;
  }
});
