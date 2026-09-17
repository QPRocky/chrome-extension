// Fallback for forms that are not built with redux-form: reads and writes the
// DOM controls directly. Only native inputs, selects and textareas are covered.
import type { DetectedForm, FillEntry, FillResult, FormField } from '../../shared/messages';
import { serialize } from '../../shared/serialize';

export const DOM_PREFIX = 'dom';

const CONTROL_SELECTOR = 'input,select,textarea';
const SKIPPED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password']);
const MAX_PASSES = 3;

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface DomField {
  key: string;
  kind: string;
  /** Every element of the field: a radio group has one per option. */
  elements: Control[];
  value: unknown;
  restorable: boolean;
}

interface DomFormHandle {
  id: string;
  name: string;
  key: string;
  detail?: string;
  fields: DomField[];
}

/** Lists the forms on the page, plus one group for controls outside any form. */
export function detectDomForms(doc: Document, loc: Pick<Location, 'pathname'>): DetectedForm[] {
  return handles(doc, loc).map((handle) => ({
    id: handle.id,
    kind: 'dom' as const,
    name: handle.name,
    key: handle.key,
    detail: handle.detail,
    fields: handle.fields.map(
      (field): FormField => ({ path: field.key, kind: field.kind, value: serialize(field.value), restorable: field.restorable }),
    ),
  }));
}

/**
 * Writes values into the form's controls with native setters plus `input` and
 * `change` events, which is what React listens to. Fields that are missing are
 * retried on later passes so conditionally rendered controls get their value.
 */
export async function fillDomForm(
  doc: Document,
  loc: Pick<Location, 'pathname'>,
  formId: string,
  entries: FillEntry[],
  touch: boolean,
): Promise<FillResult> {
  const result: FillResult = { filled: [], skipped: [] };
  let remaining = entries;

  for (let pass = 0; pass < MAX_PASSES && remaining.length > 0; pass++) {
    if (pass > 0) await nextFrame();
    const handle = handles(doc, loc).find((candidate) => candidate.id === formId);
    if (!handle) {
      if (pass === 0) throw new Error('That form is no longer on the page');
      break;
    }
    const byKey = new Map(handle.fields.map((field) => [field.key, field]));
    const pending: FillEntry[] = [];

    for (const entry of remaining) {
      const field = byKey.get(entry.path);
      if (!field) {
        pending.push(entry);
        continue;
      }
      try {
        applyValue(field, entry.value, touch);
        result.filled.push(entry.path);
      } catch (err) {
        result.skipped.push({ path: entry.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    remaining = pending;
  }

  for (const entry of remaining) result.skipped.push({ path: entry.path, reason: 'Field not found on the page' });
  return result;
}

/** `/hakemus/1234/muokkaa` → `/hakemus/*​/muokkaa`, so ids in the path do not split recordings. */
export function pathPattern(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isIdSegment(segment) ? '*' : segment))
    .join('/');
}

function isIdSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  return segment.length >= 16 && /^[0-9a-z_-]+$/i.test(segment) && /\d/.test(segment);
}

function handles(doc: Document, loc: Pick<Location, 'pathname'>): DomFormHandle[] {
  const groups = new Map<HTMLFormElement | null, Control[]>();
  for (const el of doc.querySelectorAll<Control>(CONTROL_SELECTOR)) {
    if (!isFillable(el)) continue;
    const group = groups.get(el.form) ?? [];
    group.push(el);
    groups.set(el.form, group);
  }

  const pattern = pathPattern(loc.pathname);
  const result: DomFormHandle[] = [];
  let index = 0;
  for (const [form, controls] of groups) {
    const fields = collectFields(doc, controls);
    if (fields.length === 0) continue;
    const name = form ? formName(doc, form, index) : 'Page fields';
    result.push({
      id: `${DOM_PREFIX}:${index}`,
      name,
      key: `${pattern}|${name}`,
      detail: form ? undefined : 'Controls outside any <form>',
      fields,
    });
    index++;
  }
  // The group without a form element is last in insertion order only by chance.
  return result.sort((a, b) => Number(a.detail !== undefined) - Number(b.detail !== undefined));
}

function collectFields(doc: Document, controls: Control[]): DomField[] {
  const sharedNames = new Map<string, number>();
  for (const el of controls) {
    if (el.name) sharedNames.set(el.name, (sharedNames.get(el.name) ?? 0) + 1);
  }

  const fields: DomField[] = [];
  const byKey = new Map<string, DomField>();
  const used = new Map<string, number>();

  for (const el of controls) {
    const radio = isInput(el) && el.type === 'radio';
    const group = radio && el.name ? `radio:${el.name}` : null;
    if (group && byKey.has(group)) {
      // Another option of a radio group already created the field.
      byKey.get(group)!.elements.push(el);
      continue;
    }

    let key = label(doc, el);
    if (isInput(el) && el.type === 'checkbox' && el.name && (sharedNames.get(el.name) ?? 0) > 1) key = `${el.name}[${el.value}]`;
    if (!radio) {
      const seen = used.get(key) ?? 0;
      used.set(key, seen + 1);
      if (seen > 0) key = `${key}#${seen + 1}`;
    }

    const field: DomField = { key, kind: kindOf(el), elements: [el], value: undefined, restorable: !isReadOnly(el) };
    fields.push(field);
    byKey.set(group ?? `field:${key}`, field);
  }

  for (const field of fields) field.value = readValue(field);
  return fields;
}

function readValue(field: DomField): unknown {
  const [first] = field.elements;
  if (field.kind === 'radio') return field.elements.find((el) => (el as HTMLInputElement).checked)?.value ?? null;
  if (field.kind === 'checkbox') return (first as HTMLInputElement).checked;
  if (field.kind === 'select-multiple') return [...(first as HTMLSelectElement).selectedOptions].map((option) => option.value);
  return first.value;
}

function applyValue(field: DomField, serialized: unknown, touch: boolean): void {
  const value = serialized === null || serialized === undefined || isUndefinedMarker(serialized) ? null : serialized;
  const [first] = field.elements;

  switch (field.kind) {
    case 'radio': {
      const wanted = value === null ? null : String(value);
      const target = field.elements.find((el) => el.value === wanted) as HTMLInputElement | undefined;
      if (!target) throw new Error(`No radio option with value "${wanted}"`);
      if (!target.checked) target.click();
      break;
    }
    case 'checkbox': {
      const input = first as HTMLInputElement;
      const wanted = value === null ? false : Boolean(value);
      if (input.checked !== wanted) input.click();
      break;
    }
    case 'select-multiple': {
      const select = first as HTMLSelectElement;
      const wanted = new Set((Array.isArray(value) ? value : [value]).filter((item) => item !== null).map(String));
      for (const option of select.options) option.selected = wanted.has(option.value);
      fire(select, 'input');
      fire(select, 'change');
      break;
    }
    case 'select-one': {
      const select = first as HTMLSelectElement;
      const wanted = value === null ? '' : String(value);
      if (wanted && ![...select.options].some((option) => option.value === wanted)) throw new Error(`No option with value "${wanted}"`);
      setNativeValue(select, wanted);
      fire(select, 'input');
      fire(select, 'change');
      break;
    }
    default: {
      if (isReadOnly(first)) throw new Error('Field is read-only');
      setNativeValue(first, value === null ? '' : String(value));
      fire(first, 'input');
      fire(first, 'change');
    }
  }

  if (touch) {
    const el = field.kind === 'radio' ? (field.elements.find((option) => (option as HTMLInputElement).checked) ?? first) : first;
    fire(el, 'focusout');
    el.dispatchEvent(new FocusEvent('blur'));
  }
}

/**
 * React tracks the last value it wrote on the element itself, so assigning
 * through the prototype's setter is what makes it see a change.
 */
function setNativeValue(el: Control, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
}

function fire(el: Element, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function isFillable(el: Control): boolean {
  if (el.disabled || el.hidden) return false;
  if (isInput(el) && SKIPPED_TYPES.has(el.type)) return false;
  return true;
}

function kindOf(el: Control): string {
  if (el instanceof HTMLTextAreaElement || el.tagName === 'TEXTAREA') return 'textarea';
  if (isSelect(el)) return el.multiple ? 'select-multiple' : 'select-one';
  return (el as HTMLInputElement).type || 'text';
}

/** Field key: the most stable identifier the control offers. */
function label(doc: Document, el: Control): string {
  const named = el.getAttribute('name') || el.id || el.getAttribute('aria-label') || labelText(doc, el) || el.getAttribute('placeholder');
  return named || `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).type || 'text'}`;
}

function labelText(doc: Document, el: Control): string {
  const explicit = el.id ? [...doc.querySelectorAll('label[for]')].find((candidate) => candidate.getAttribute('for') === el.id) : undefined;
  const wrapping = el.closest('label');
  const text = (explicit ?? wrapping)?.textContent ?? '';
  return text.trim().replace(/\s+/g, ' ').slice(0, 60);
}

function formName(doc: Document, form: HTMLFormElement, index: number): string {
  const labelled = form.getAttribute('aria-labelledby');
  const labelledText = labelled ? (doc.getElementById(labelled)?.textContent ?? '') : '';
  const legend = form.querySelector('legend')?.textContent ?? '';
  const name =
    form.getAttribute('name') ||
    form.id ||
    form.getAttribute('aria-label') ||
    labelledText.trim() ||
    legend.trim();
  return (name || `Form ${index + 1}`).replace(/\s+/g, ' ').slice(0, 60);
}

function isUndefinedMarker(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).$devkit === 'undefined';
}

function isReadOnly(el: Control): boolean {
  return (el as HTMLInputElement).readOnly === true;
}

function isInput(el: Control): el is HTMLInputElement {
  return el.tagName === 'INPUT';
}

function isSelect(el: Control): el is HTMLSelectElement {
  return el.tagName === 'SELECT';
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}
