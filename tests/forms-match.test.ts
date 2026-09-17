import { describe, expect, it } from 'vitest';
import { compareEntries, extraFields, matchRecordings, unappliedFields, unmatchedRecordings } from '../src/panel/forms/match';
import type { Recording } from '../src/panel/forms/storage';
import type { DetectedForm, FormField } from '../src/shared/messages';

const ORIGIN = 'https://app.example.fi';

function form(overrides: Omit<Partial<DetectedForm>, 'fields'> & { fields: [string, unknown][] }): DetectedForm {
  const fields: FormField[] = overrides.fields.map(([path, value]) => ({ path, kind: 'Field', value, restorable: true }));
  return {
    id: overrides.id ?? 'rf:store-1:signup',
    kind: overrides.kind ?? 'redux-form',
    name: overrides.name ?? 'signup',
    key: overrides.key ?? overrides.name ?? 'signup',
    fields,
  };
}

function recording(overrides: Omit<Partial<Recording>, 'entries'> & { entries: [string, unknown][] }): Recording {
  return {
    id: overrides.id ?? 'r1',
    name: overrides.name ?? 'Happy path',
    kind: overrides.kind ?? 'redux-form',
    formKey: overrides.formKey ?? 'signup',
    formName: overrides.formName ?? 'signup',
    origin: overrides.origin ?? ORIGIN,
    path: overrides.path ?? '/signup',
    entries: overrides.entries.map(([path, value]) => ({ path, kind: 'Field', value, include: true })),
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
    lastUsedAt: overrides.lastUsedAt,
  };
}

describe('matchRecordings', () => {
  it('offers recordings of the same form name', () => {
    const matches = matchRecordings(form({ fields: [['email', 'a']] }), [recording({ entries: [['email', 'b']] })], ORIGIN);
    expect(matches.map((match) => match.exact)).toEqual([true]);
  });

  it('hides recordings from other origins', () => {
    const other = recording({ entries: [['email', 'b']], origin: 'https://test.example.fi' });
    expect(matchRecordings(form({ fields: [['email', 'a']] }), [other], ORIGIN)).toEqual([]);
  });

  it('does not mix redux-form and DOM recordings', () => {
    const dom = recording({ entries: [['email', 'b']], kind: 'dom' });
    expect(matchRecordings(form({ fields: [['email', 'a']] }), [dom], ORIGIN)).toEqual([]);
  });

  it('accepts a DOM form whose markup changed but keeps most fields', () => {
    const target = form({ kind: 'dom', name: 'Form 1', key: '/order|Form 1', fields: [['email', ''], ['city', ''], ['zip', '']] });
    const moved = recording({ kind: 'dom', formKey: '/order|Form 2', entries: [['email', 'a'], ['city', 'b'], ['gone', 'c']] });
    const unrelated = recording({ id: 'r2', kind: 'dom', formKey: '/other|Form 9', entries: [['x', '1'], ['y', '2']] });

    const matches = matchRecordings(target, [moved, unrelated], ORIGIN);
    expect(matches).toHaveLength(1);
    expect(matches[0].exact).toBe(false);
    expect(matches[0].score).toBeCloseTo(2 / 3);
  });

  it('puts exact matches first, then the most recently used', () => {
    const exact = recording({ id: 'exact', entries: [['email', 'a']] });
    const older = recording({ id: 'older', entries: [['email', 'a']], lastUsedAt: 10 });
    const newer = recording({ id: 'newer', entries: [['email', 'a']], lastUsedAt: 20 });
    const matches = matchRecordings(form({ fields: [['email', '']] }), [older, exact, newer], ORIGIN);
    expect(matches.map((match) => match.recording.id)).toEqual(['newer', 'older', 'exact']);
  });
});

describe('unmatchedRecordings', () => {
  it('lists this origin’s recordings that no detected form claims', () => {
    const onPage = recording({ id: 'on-page', entries: [['email', 'a']] });
    const elsewhere = recording({ id: 'elsewhere', formKey: 'invoice', formName: 'invoice', entries: [['sum', 1]] });
    const otherOrigin = recording({ id: 'other', formKey: 'invoice', origin: 'https://test.example.fi', entries: [['sum', 1]] });

    const rest = unmatchedRecordings([form({ fields: [['email', '']] })], [onPage, elsewhere, otherOrigin], ORIGIN);
    expect(rest.map((r) => r.id)).toEqual(['elsewhere']);
  });
});

describe('compareEntries', () => {
  const saved = recording({ entries: [['email', 'a@b.fi'], ['city', 'Helsinki'], ['gone', 'x']] });

  it('marks fields same, different and missing', () => {
    const rows = compareEntries(saved, form({ fields: [['email', 'a@b.fi'], ['city', 'Tampere']] }));
    expect(rows.map((row) => [row.path, row.status])).toEqual([
      ['email', 'same'],
      ['city', 'different'],
      ['gone', 'missing'],
    ]);
  });

  it('compares values structurally, not by key order', () => {
    const rows = compareEntries(recording({ entries: [['address', { city: 'Oulu', zip: '90100' }]] }), form({ fields: [['address', { zip: '90100', city: 'Oulu' }]] }));
    expect(rows[0].status).toBe('same');
  });

  it('reports unknown status when the form is not on the page', () => {
    expect(compareEntries(saved, undefined).every((row) => row.status === 'unknown')).toBe(true);
  });

  it('lists fields the recording does not set', () => {
    expect(extraFields(saved, form({ fields: [['email', ''], ['phone', '']] }))).toEqual(['phone']);
  });

  it('names the included fields that did not keep the filled value', () => {
    const partly = recording({ entries: [['email', 'a@b.fi'], ['city', 'Helsinki']] });
    partly.entries[0].include = false;
    expect(unappliedFields(partly, form({ fields: [['email', ''], ['city', '']] }))).toEqual(['city']);
  });
});

describe('empty values', () => {
  it('treats a saved empty value and a dropped one as the same', () => {
    const saved = recording({ entries: [['city', ''], ['items', []], ['note', 'x']] });
    const rows = compareEntries(saved, form({ fields: [['city', { $devkit: 'undefined' }], ['items', []], ['note', 'x']] }));
    expect(rows.map((row) => row.status)).toEqual(['same', 'same', 'same']);
  });
});
