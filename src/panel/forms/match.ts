import { diff } from '../../shared/diff';
import type { DetectedForm } from '../../shared/messages';
import type { Recording } from './storage';

/** How much of a recording's fields a DOM form must still have to count as a match. */
const PARTIAL_MIN = 0.6;

/** Recordings are listed by name, so the same one always sits in the same place. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export interface Match {
  recording: Recording;
  /** True when the form key is identical; false for a partial DOM match. */
  exact: boolean;
  /** Share of the recording's fields the form currently has, 0–1. */
  score: number;
}

/**
 * Recordings offered for a form: same origin and form kind, and either the same
 * form key or — for DOM forms, whose keys depend on markup — enough of the same
 * fields.
 */
export function matchRecordings(form: DetectedForm, recordings: readonly Recording[], origin: string): Match[] {
  const paths = new Set(form.fields.map((field) => field.path));
  const matches: Match[] = [];

  for (const recording of recordings) {
    if (recording.origin !== origin || recording.kind !== form.kind) continue;
    const exact = recording.formKey === form.key;
    const score = overlap(recording, paths);
    if (!exact && (form.kind !== 'dom' || score < PARTIAL_MIN)) continue;
    matches.push({ recording, exact, score });
  }

  return matches.sort((a, b) => Number(b.exact) - Number(a.exact) || byName.compare(a.recording.name, b.recording.name));
}

/** Recordings of this origin that none of the detected forms claims. */
export function unmatchedRecordings(forms: readonly DetectedForm[], recordings: readonly Recording[], origin: string): Recording[] {
  const claimed = new Set(forms.flatMap((form) => matchRecordings(form, recordings, origin).map((match) => match.recording.id)));
  return recordings.filter((recording) => recording.origin === origin && !claimed.has(recording.id)).sort((a, b) => byName.compare(a.name, b.name));
}

export type FieldStatus = 'same' | 'different' | 'missing' | 'unknown';

export interface CompareRow {
  path: string;
  kind: string;
  saved: unknown;
  current: unknown;
  status: FieldStatus;
  include: boolean;
  /** False when the form no longer accepts a value for this field. */
  restorable: boolean;
}

/** Rows for the detail table: saved value next to the form's current value. */
export function compareEntries(recording: Recording, form: DetectedForm | undefined): CompareRow[] {
  return recording.entries.map((entry) => {
    const field = form?.fields.find((candidate) => candidate.path === entry.path);
    let status: FieldStatus = 'unknown';
    if (form) status = !field ? 'missing' : sameValue(entry.value, field.value) ? 'same' : 'different';
    return {
      path: entry.path,
      kind: field?.kind ?? entry.kind,
      saved: entry.value,
      current: field?.value,
      status,
      include: entry.include,
      restorable: field?.restorable ?? true,
    };
  });
}

/** Fields in the form that the recording does not cover. */
export function extraFields(recording: Recording, form: DetectedForm | undefined): string[] {
  if (!form) return [];
  const saved = new Set(recording.entries.map((entry) => entry.path));
  return form.fields.filter((field) => !saved.has(field.path)).map((field) => field.path);
}

/**
 * Included fields that did not end up with the saved value. Used right after a
 * fill, where a mismatch usually means the app reset a dependent field.
 */
export function unappliedFields(recording: Recording, form: DetectedForm | undefined): string[] {
  return compareEntries(recording, form)
    .filter((row) => row.include && (row.status === 'different' || row.status === 'missing'))
    .map((row) => row.path);
}

/**
 * redux-form drops a value instead of storing an empty string, so an empty
 * saved value and a missing current one are the same thing.
 */
function sameValue(saved: unknown, current: unknown): boolean {
  if (isEmpty(saved) && isEmpty(current)) return true;
  return diff(saved, current).length === 0;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && (value as Record<string, unknown>).$devkit === 'undefined';
}

function overlap(recording: Recording, paths: ReadonlySet<string>): number {
  if (recording.entries.length === 0) return 0;
  const shared = recording.entries.filter((entry) => paths.has(entry.path)).length;
  return shared / recording.entries.length;
}
