import './panel.css';
import { createFormsView } from './forms/view';
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

type ViewId = 'network' | 'redux' | 'forms';
const VIEW_KEY = 'panel.view';
const LABELS: Record<ViewId, string> = { network: 'Network', redux: 'Redux', forms: 'Forms' };

document.documentElement.dataset.theme = chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';

const networkRoot = h('section', { class: 'view' });
const reduxRoot = h('section', { class: 'view' });
const formsRoot = h('section', { class: 'view' });
const views: Record<ViewId, HTMLElement> = { network: networkRoot, redux: reduxRoot, forms: formsRoot };

const tabButtons = (Object.keys(views) as ViewId[]).map((id) =>
  h('button', { type: 'button', class: 'main-tab', dataset: { view: id }, onClick: () => show(id) }, LABELS[id]),
);

document.getElementById('app')!.append(h('nav', { class: 'main-tabs' }, ...tabButtons), networkRoot, reduxRoot, formsRoot);

const network = createNetworkView(networkRoot);
window.devkit = { attachNetwork: (store) => network.attach(store) };

const client = new ReduxClient(chrome.devtools.inspectedWindow.tabId);
client.connect();
const navigation = { onNavigated: (listener: () => void) => chrome.devtools.network.onNavigated.addListener(() => listener()) };
createReduxView(reduxRoot, client, navigation);
const formsView = createFormsView(formsRoot, client, navigation);

show(readView());

function show(id: ViewId): void {
  for (const [viewId, el] of Object.entries(views)) el.hidden = viewId !== id;
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.view === id);
  // The page's forms change as the user navigates, so the list is re-read on every visit.
  if (id === 'forms') formsView.refresh();
  try {
    localStorage.setItem(VIEW_KEY, id);
  } catch {
    // storage unavailable
  }
}

function readView(): ViewId {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved && saved in views) return saved as ViewId;
  } catch {
    // storage unavailable
  }
  return 'network';
}
