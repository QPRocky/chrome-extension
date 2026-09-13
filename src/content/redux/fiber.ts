import { isStoreLike, type ReduxStore } from './types';

interface Fiber {
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
  stateNode: unknown;
}

const MAX_ELEMENTS = 20_000;
const MAX_FIBERS = 200_000;

/**
 * Finds Redux stores passed to react-redux `<Provider store>` by walking the
 * React fiber tree. Works for production builds without any app changes.
 */
export function findStoresInReactTree(doc: Document): ReduxStore[] {
  const stores = new Set<ReduxStore>();
  for (const root of findRootFibers(doc)) {
    walkFibers(root, (fiber) => {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') return;
      if (isStoreLike(props.store)) stores.add(props.store);
      // react-redux context provider: value={{ store, subscription }}
      const value = props.value as { store?: unknown } | null | undefined;
      if (value && typeof value === 'object' && isStoreLike(value.store)) stores.add(value.store);
    });
  }
  return [...stores];
}

function findRootFibers(doc: Document): Fiber[] {
  const roots = new Set<Fiber>();
  const elements = doc.querySelectorAll('*');
  const limit = Math.min(elements.length, MAX_ELEMENTS);
  let anyFiber: Fiber | null = null;

  for (let i = 0; i < limit; i++) {
    const el = elements[i] as unknown as Record<string, unknown>;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactContainer$')) {
        // React 17+: the container element points at its HostRoot fiber.
        const fiber = el[key] as Fiber | null;
        if (fiber) roots.add(currentRoot(topOf(fiber)));
      } else if (key === '_reactRootContainer') {
        // React 16 legacy root.
        const legacy = el[key] as { _internalRoot?: { current?: Fiber } } | null;
        const current = legacy?._internalRoot?.current;
        if (current) roots.add(current);
      } else if (!anyFiber && key.startsWith('__reactFiber$')) {
        anyFiber = el[key] as Fiber | null;
      }
    }
  }

  if (roots.size === 0 && anyFiber) roots.add(currentRoot(topOf(anyFiber)));
  return [...roots];
}

function topOf(fiber: Fiber): Fiber {
  let node = fiber;
  while (node.return) node = node.return;
  return node;
}

/** The HostRoot fiber's stateNode is the FiberRoot whose `current` is the committed tree. */
function currentRoot(hostRoot: Fiber): Fiber {
  const fiberRoot = hostRoot.stateNode as { current?: Fiber } | null;
  return fiberRoot?.current ?? hostRoot;
}

function walkFibers(root: Fiber, visit: (fiber: Fiber) => void): void {
  const stack: Fiber[] = [root];
  let count = 0;
  while (stack.length > 0 && count < MAX_FIBERS) {
    const fiber = stack.pop()!;
    count++;
    visit(fiber);
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
}
