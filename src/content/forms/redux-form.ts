// Reads and writes redux-form state. Runs in the page's MAIN world.
import { diff } from '../../shared/diff';
import { getField, isChildField } from '../../shared/field-path';
import type { DetectedForm, FillEntry, FillResult, FormField } from '../../shared/messages';
import { isMarker, revive, serialize } from '../../shared/serialize';
import type { StoreRecord } from '../redux/registry';

const CHANGE = '@@redux-form/CHANGE';
const TOUCH = '@@redux-form/TOUCH';

export const RF_PREFIX = 'rf';

interface RegisteredField {
  name: string;
  type: string;
}

interface RfFormState {
  registeredFields?: Record<string, RegisteredField>;
  values?: unknown;
  initial?: unknown;
}

export interface FormRoot {
  /** State key the redux-form reducer is mounted at, `form` unless `getFormState` says otherwise. */
  mountKey: string;
  forms: Record<string, RfFormState>;
}

/** Finds the redux-form reducer's slice in a store state. */
export function findFormRoot(state: unknown): FormRoot | null {
  if (!isRecord(state)) return null;
  if (isFormsMap(state.form)) return { mountKey: 'form', forms: state.form };
  for (const [key, value] of Object.entries(state)) {
    if (isFormsMap(value)) return { mountKey: key, forms: value };
  }
  return null;
}

/** Lists the mounted redux-form forms of every known store. */
export function detectReduxForms(records: readonly StoreRecord[]): DetectedForm[] {
  const forms: DetectedForm[] = [];
  for (const record of records) {
    let root: FormRoot | null = null;
    try {
      root = findFormRoot(record.inner.getState());
    } catch {
      // A store that throws on getState is of no use here.
    }
    if (!root) continue;
    for (const [name, form] of Object.entries(root.forms)) {
      const fields = formFields(form);
      // A form with no registered fields is not on screen (destroyOnUnmount: false leftover).
      if (fields.length === 0) continue;
      forms.push({
        id: `${RF_PREFIX}:${record.id}:${name}`,
        kind: 'redux-form',
        name,
        key: name,
        detail: `${record.name} · state.${root.mountKey}.${name}`,
        fields,
      });
    }
  }
  return forms;
}

/**
 * Writes values into a form by dispatching the same actions redux-form's own
 * `change` action creator produces, so middleware and sagas see them as user
 * edits. Fields that are not registered yet are written anyway: redux-form
 * keeps the value and a conditionally rendered field picks it up when it mounts.
 */
export function fillReduxForm(record: StoreRecord, formName: string, entries: FillEntry[], touch: boolean): FillResult {
  const store = record.outer ?? record.inner;
  const result: FillResult = { filled: [], skipped: [] };

  for (const entry of entries) {
    try {
      store.dispatch({
        type: CHANGE,
        meta: { form: formName, field: entry.path, touch: false, persistentSubmitErrors: false },
        payload: revive(entry.value),
      });
      result.filled.push(entry.path);
    } catch (err) {
      result.skipped.push({ path: entry.path, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (touch && result.filled.length > 0) {
    try {
      store.dispatch({ type: TOUCH, meta: { form: formName, fields: result.filled } });
    } catch {
      // Touching is cosmetic; the values are already in.
    }
  }
  return result;
}

function formFields(form: RfFormState): FormField[] {
  const registered = Object.values(form.registeredFields ?? {}).filter((field): field is RegisteredField => isRecord(field) && typeof field.name === 'string');
  const arrays = registered.filter((field) => field.type === 'FieldArray').map((field) => field.name);

  const fields: FormField[] = [];
  for (const field of registered) {
    // A FieldArray is saved as a whole, so its children are left out.
    if (arrays.some((array) => isChildField(field.name, array))) continue;
    const value = getField(form.values, field.name);
    const initial = getField(form.initial, field.name);
    const serialized = serialize(value);
    fields.push({
      path: field.name,
      kind: typeof field.type === 'string' ? field.type : 'Field',
      value: serialized,
      dirty: diff(initial, value).length > 0,
      restorable: isRestorable(serialized),
    });
  }
  return fields;
}

/** False for serialized values `revive` cannot reconstruct, e.g. a File input's value. */
function isRestorable(serialized: unknown): boolean {
  if (Array.isArray(serialized)) return serialized.every(isRestorable);
  if (typeof serialized !== 'object' || serialized === null) return true;
  if (!isMarker(serialized)) return Object.values(serialized).every(isRestorable);
  switch (serialized.$devkit) {
    case 'function':
    case 'symbol':
    case 'circular':
    case 'truncated':
    case 'opaque':
    case 'unreadable':
      return false;
    case 'Map':
      return serialized.entries.every(([key, value]) => isRestorable(key) && isRestorable(value));
    case 'Set':
      return serialized.values.every(isRestorable);
    case 'object':
      return Object.values(serialized.value).every(isRestorable);
    default:
      return true;
  }
}

/** A `{ [formName]: formState }` map as produced by the redux-form reducer. */
function isFormsMap(value: unknown): value is Record<string, RfFormState> {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.some(isFormState);
}

function isFormState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isRecord(value.registeredFields)) return true;
  return 'values' in value && ('initial' in value || 'fields' in value || 'anyTouched' in value || 'submitSucceeded' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
