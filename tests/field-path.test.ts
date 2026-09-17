import { describe, expect, it } from 'vitest';
import { getField, getIn, isChildField, parsePath } from '../src/shared/field-path';

describe('parsePath', () => {
  it('splits dotted and indexed field names', () => {
    expect(parsePath('email')).toEqual(['email']);
    expect(parsePath('address.street')).toEqual(['address', 'street']);
    expect(parsePath('items[0].code')).toEqual(['items', 0, 'code']);
    expect(parsePath('items[10][2]')).toEqual(['items', 10, 2]);
  });

  it('supports quoted keys', () => {
    expect(parsePath('meta["odd key"].value')).toEqual(['meta', 'odd key', 'value']);
  });
});

describe('getIn', () => {
  const values = { address: { street: 'Mannerheimintie 1' }, items: [{ code: 'A' }, { code: 'B' }], zero: 0 };

  it('reads nested values', () => {
    expect(getField(values, 'address.street')).toBe('Mannerheimintie 1');
    expect(getField(values, 'items[1].code')).toBe('B');
    expect(getField(values, 'zero')).toBe(0);
  });

  it('returns undefined for missing steps instead of throwing', () => {
    expect(getField(values, 'address.city')).toBeUndefined();
    expect(getField(values, 'items[5].code')).toBeUndefined();
    expect(getField(undefined, 'items[0]')).toBeUndefined();
    expect(getIn('text', ['length'])).toBeUndefined();
  });
});

describe('isChildField', () => {
  it('recognizes fields inside a FieldArray', () => {
    expect(isChildField('items[0].code', 'items')).toBe(true);
    expect(isChildField('items.code', 'items')).toBe(true);
    expect(isChildField('itemsTotal', 'items')).toBe(false);
    expect(isChildField('items', 'items')).toBe(false);
  });
});
