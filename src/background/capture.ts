import { CdpNetworkRecorder, withPostData, type FinishedRequest } from '../shared/cdp-har';
import { SOURCE, isEnvelope, type CaptureCommand, type CaptureEvent, type Envelope } from '../shared/messages';
import type { ContentState, NetEntry } from '../panel/network/store';

interface Session {
  tabId: number;
  port: chrome.runtime.Port;
  recorder: CdpNetworkRecorder;
  attached: boolean;
  maxChars: number;
  queue: Promise<void>;
}

const MB = 1024 * 1024;
const sessions = new Map<number, Session>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  // Child sessions (out-of-process iframes, workers) are not attached to.
  if (source.tabId === undefined || source.sessionId) return;
  const session = sessions.get(source.tabId);
  if (session?.attached) session.recorder.handle(method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const session = source.tabId !== undefined ? sessions.get(source.tabId) : undefined;
  if (!session?.attached) return;
  session.attached = false;
  session.recorder.reset();
  post(session, { kind: 'detached', reason });
});

/** Serves one DevTools page's Full capture port. */
export function handleCapturePort(port: chrome.runtime.Port, tabId: number): void {
  const previous = sessions.get(tabId);
  if (previous) enqueue(previous, () => stop(previous));

  const session: Session = {
    tabId,
    port,
    attached: false,
    maxChars: 0,
    recorder: new CdpNetworkRecorder((request) => void deliver(session, request)),
    queue: Promise.resolve(),
  };
  sessions.set(tabId, session);

  port.onMessage.addListener((message: unknown) => {
    if (!isEnvelope(message)) return;
    const command = message.payload as CaptureCommand;
    if (command.kind === 'start') enqueue(session, () => start(session, command.maxBodyMB));
  });
  port.onDisconnect.addListener(() => {
    if (sessions.get(tabId) === session) sessions.delete(tabId);
    enqueue(session, () => stop(session));
  });
}

/** Attach and detach calls must not interleave. */
function enqueue(session: Session, task: () => Promise<void>): void {
  session.queue = session.queue.then(task, task);
}

async function start(session: Session, maxBodyMB: number): Promise<void> {
  const target = { tabId: session.tabId };
  const bytes = maxBodyMB * MB;
  session.maxChars = bytes;
  try {
    if (!session.attached) {
      // A session left over from a previous service worker instance blocks attaching.
      await chrome.debugger.detach(target).catch(() => {});
      await chrome.debugger.attach(target, '1.3');
      session.attached = true;
    }
    // Chrome evicts bodies beyond these buffers, so size them to the body limit.
    await chrome.debugger.sendCommand(target, 'Network.enable', {
      maxResourceBufferSize: Math.max(bytes, 10 * MB),
      maxTotalBufferSize: Math.max(bytes * 4, 100 * MB),
      maxPostDataSize: 64 * 1024,
    });
  } catch (err) {
    if (session.attached) await stop(session);
    post(session, { kind: 'error', message: `Full capture failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function stop(session: Session): Promise<void> {
  if (!session.attached) return;
  session.attached = false;
  session.recorder.reset();
  await chrome.debugger.detach({ tabId: session.tabId }).catch(() => {});
}

async function deliver(session: Session, { requestId, har, hasBody, needsPostData }: FinishedRequest): Promise<void> {
  const target = { tabId: session.tabId };
  if (needsPostData) {
    try {
      const { postData } = (await chrome.debugger.sendCommand(target, 'Network.getRequestPostData', { requestId })) as { postData: string };
      withPostData(har, postData);
    } catch {
      // body no longer available
    }
  }

  let contentState: ContentState = 'empty';
  let content: NetEntry['content'];
  if (hasBody) {
    try {
      const { body, base64Encoded } = (await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId })) as {
        body: string;
        base64Encoded: boolean;
      };
      if (!body) contentState = 'empty';
      else if (body.length > session.maxChars) contentState = 'too-large';
      else {
        content = base64Encoded ? { text: body, encoding: 'base64' } : { text: body };
        contentState = 'loaded';
      }
    } catch {
      contentState = 'error';
    }
  }

  if (!post(session, { kind: 'entry', har, contentState, content })) {
    // Most likely over the extension message size limit.
    post(session, { kind: 'entry', har, contentState: content ? 'too-large' : contentState });
  }
}

function post(session: Session, event: CaptureEvent): boolean {
  const envelope: Envelope<CaptureEvent> = { source: SOURCE, payload: event };
  try {
    session.port.postMessage(envelope);
    return true;
  } catch {
    return false;
  }
}
