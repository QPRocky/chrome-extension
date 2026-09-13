import { NetworkStore, chromeSettingsStorage, type NetworkApi } from '../panel/network/store';
import { CaptureClient } from './capture-client';

// The DevTools page lives as long as DevTools is open, so network capture starts
// here immediately instead of when the panel is first shown.
const store = new NetworkStore(chromeSettingsStorage);
new CaptureClient(store, chrome.devtools.inspectedWindow.tabId).start();
void store.start(chrome.devtools.network as unknown as NetworkApi);

chrome.devtools.panels.create('DevKit', '', 'panel/panel.html', (panel) => {
  panel.onShown.addListener((panelWindow) => attach(panelWindow));
});

function attach(panelWindow: Window, attempt = 0): void {
  const devkit = panelWindow.devkit;
  if (devkit) devkit.attachNetwork(store);
  else if (attempt < 50) setTimeout(() => attach(panelWindow, attempt + 1), 100);
}
