import './panel.css';
import { createNetworkView } from './network/view';
import type { NetworkStore } from './network/store';
import { ReduxClient } from './redux/client';
import { createReduxView } from './redux/view';
import { h } from './ui/dom';

declare global {
  interface Window {
    /** Set by the panel, called from the DevTools page to hand over its network store. */
    devkit?: { attachNetwork(store: NetworkStore): void };
  }
}

type ViewId = 'network' | 'redux';
const VIEW_KEY = 'panel.view';

document.documentElement.dataset.theme = chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';

const networkRoot = h('section', { class: 'view' });
const reduxRoot = h('section', { class: 'view' });
const views: Record<ViewId, HTMLElement> = { network: networkRoot, redux: reduxRoot };

const tabButtons = (Object.keys(views) as ViewId[]).map((id) =>
  h('button', { type: 'button', class: 'main-tab', dataset: { view: id }, onClick: () => show(id) }, id === 'network' ? 'Network' : 'Redux'),
);

document.getElementById('app')!.append(h('nav', { class: 'main-tabs' }, ...tabButtons), networkRoot, reduxRoot);

const network = createNetworkView(networkRoot);
window.devkit = { attachNetwork: (store) => network.attach(store) };

const client = new ReduxClient(chrome.devtools.inspectedWindow.tabId);
client.connect();
createReduxView(reduxRoot, client, {
  onNavigated: (listener) => chrome.devtools.network.onNavigated.addListener(() => listener()),
});

show(readView());

function show(id: ViewId): void {
  for (const [viewId, el] of Object.entries(views)) el.hidden = viewId !== id;
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.view === id);
  try {
    localStorage.setItem(VIEW_KEY, id);
  } catch {
    // storage unavailable
  }
}

function readView(): ViewId {
  try {
    return localStorage.getItem(VIEW_KEY) === 'redux' ? 'redux' : 'network';
  } catch {
    return 'network';
  }
}
