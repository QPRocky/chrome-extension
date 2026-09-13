import { describe, expect, it } from 'vitest';
import { describeMarker, isMarker, revive, serialize } from '../src/shared/serialize';

describe('serialize', () => {
  it('passes JSON values through unchanged', () => {
    const value = { a: 1, b: 'x', c: [true, null, { d: 2.5 }] };
    expect(serialize(value)).toEqual(value);
  });

  it('marks circular references with the path of the ancestor', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    a.list = [a];
    expect(serialize(a)).toEqual({
      name: 'a',
      self: { $devkit: 'circular', path: '$' },
      list: [{ $devkit: 'circular', path: '$' }],
    });
  });

  it('does not treat shared (non-circular) references as cycles', () => {
    const shared = { x: 1 };
    expect(serialize({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('round-trips special values through revive', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    const value = {
      u: undefined,
      n: NaN,
      inf: -Infinity,
      big: 12345678901234567890n,
      date,
      re: /ab+c/gi,
      map: new Map<unknown, unknown>([['k', { v: 1 }]]),
      set: new Set([1, 2]),
    };
    const json = JSON.parse(JSON.stringify(serialize(value)));
    const back = revive(json) as typeof value;
    expect(back.u).toBeUndefined();
    expect('u' in back).toBe(true);
    expect(back.n).toBeNaN();
    expect(back.inf).toBe(-Infinity);
    expect(back.big).toBe(12345678901234567890n);
    expect(back.date).toEqual(date);
    expect(back.re).toEqual(/ab+c/gi);
    expect(back.map).toEqual(new Map([['k', { v: 1 }]]));
    expect(back.set).toEqual(new Set([1, 2]));
  });

  it('describes values that cannot be reconstructed', () => {
    function namedFn() {}
    const out = serialize({ fn: namedFn, sym: Symbol('s'), err: new TypeError('boom') }) as Record<string, unknown>;
    expect(out.fn).toEqual({ $devkit: 'function', name: 'namedFn' });
    expect(out.sym).toEqual({ $devkit: 'symbol', description: 's' });
    expect(out.err).toMatchObject({ $devkit: 'Error', name: 'TypeError', message: 'boom' });
    expect(isMarker(out.fn) && describeMarker(out.fn)).toBe('ƒ namedFn()');
  });

  it('truncates below maxDepth', () => {
    expect(serialize({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({
      a: { b: { $devkit: 'truncated', kind: 'Object', size: 1 } },
    });
  });

  it('escapes plain objects that contain the marker key', () => {
    const tricky = { $devkit: 'undefined', other: 1 };
    const json = serialize(tricky);
    expect(json).toEqual({ $devkit: 'object', value: { $devkit: 'undefined', other: 1 } });
    expect(revive(json)).toEqual(tricky);
  });

  it('reports getters that throw instead of failing', () => {
    const obj = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(serialize(obj)).toEqual({ bad: { $devkit: 'unreadable', message: 'nope' } });
  });
});
