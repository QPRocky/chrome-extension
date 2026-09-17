// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { detectDomForms, fillDomForm, pathPattern } from '../src/content/forms/dom';
import type { DetectedForm } from '../src/shared/messages';

const loc = { pathname: '/hakemus/123/muokkaa' };

function render(html: string): void {
  document.body.innerHTML = html;
}

function field(form: DetectedForm, path: string) {
  return form.fields.find((candidate) => candidate.path === path);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('pathPattern', () => {
  it('replaces id-looking segments so recordings survive different rows', () => {
    expect(pathPattern('/hakemus/123/muokkaa')).toBe('/hakemus/*/muokkaa');
    expect(pathPattern('/x/3f6b1c20-9c3a-4f21-9f2e-1a2b3c4d5e6f')).toBe('/x/*');
    expect(pathPattern('/hakemus/uusi')).toBe('/hakemus/uusi');
  });
});

describe('detectDomForms', () => {
  it('reads native controls and groups radios', () => {
    render(`
      <form id="order">
        <label for="email">Email</label><input id="email" name="email" value="a@b.fi" />
        <textarea name="notes">hello</textarea>
        <select name="country"><option value="fi" selected>Suomi</option><option value="se">Ruotsi</option></select>
        <select name="tags" multiple><option value="x" selected>X</option><option value="y" selected>Y</option><option value="z">Z</option></select>
        <input type="radio" name="speed" value="slow" /><input type="radio" name="speed" value="fast" checked />
        <input type="checkbox" name="terms" checked />
        <input type="password" name="secret" />
        <input type="hidden" name="csrf" value="nope" />
      </form>
    `);

    const [form] = detectDomForms(document, loc);
    expect(form.id).toBe('dom:0');
    expect(form.name).toBe('order');
    expect(form.key).toBe('/hakemus/*/muokkaa|order');
    expect(form.fields.map((f) => f.path)).toEqual(['email', 'notes', 'country', 'tags', 'speed', 'terms']);
    expect(field(form, 'email')?.value).toBe('a@b.fi');
    expect(field(form, 'country')?.value).toBe('fi');
    expect(field(form, 'tags')?.value).toEqual(['x', 'y']);
    expect(field(form, 'speed')?.value).toBe('fast');
    expect(field(form, 'terms')?.value).toBe(true);
  });

  it('names fields without a name attribute from their label, and disambiguates', () => {
    render(`
      <form>
        <label>Katuosoite <input /></label>
        <label>Katuosoite <input /></label>
        <input aria-label="Postinumero" />
        <input placeholder="Kaupunki" />
      </form>
    `);

    const [form] = detectDomForms(document, loc);
    expect(form.fields.map((f) => f.path)).toEqual(['Katuosoite', 'Katuosoite#2', 'Postinumero', 'Kaupunki']);
  });

  it('keys checkboxes that share a name by their value', () => {
    render(`<form><input type="checkbox" name="perk" value="a" checked /><input type="checkbox" name="perk" value="b" /></form>`);
    const [form] = detectDomForms(document, loc);
    expect(form.fields.map((f) => f.path)).toEqual(['perk[a]', 'perk[b]']);
    expect(field(form, 'perk[a]')?.value).toBe(true);
  });

  it('collects controls outside any form into a group of their own', () => {
    render(`<form id="real"><input name="a" /></form><input name="loose" />`);
    const forms = detectDomForms(document, loc);
    expect(forms.map((form) => form.name)).toEqual(['real', 'Page fields']);
    expect(forms[1].fields.map((f) => f.path)).toEqual(['loose']);
  });

  it('skips disabled controls', () => {
    render(`<form><input name="a" /><input name="b" disabled /></form>`);
    expect(detectDomForms(document, loc)[0].fields.map((f) => f.path)).toEqual(['a']);
  });
});

describe('fillDomForm', () => {
  it('writes every control type and reports the result', async () => {
    render(`
      <form>
        <input name="email" />
        <textarea name="notes"></textarea>
        <select name="country"><option value="fi">Suomi</option><option value="se">Ruotsi</option></select>
        <select name="tags" multiple><option value="x">X</option><option value="y">Y</option></select>
        <input type="radio" name="speed" value="slow" /><input type="radio" name="speed" value="fast" />
        <input type="checkbox" name="terms" />
      </form>
    `);

    const result = await fillDomForm(
      document,
      loc,
      'dom:0',
      [
        { path: 'email', value: 'filled@example.com' },
        { path: 'notes', value: 'note' },
        { path: 'country', value: 'se' },
        { path: 'tags', value: ['y'] },
        { path: 'speed', value: 'fast' },
        { path: 'terms', value: true },
      ],
      false,
    );

    expect(result.skipped).toEqual([]);
    const [form] = detectDomForms(document, loc);
    expect(field(form, 'email')?.value).toBe('filled@example.com');
    expect(field(form, 'notes')?.value).toBe('note');
    expect(field(form, 'country')?.value).toBe('se');
    expect(field(form, 'tags')?.value).toEqual(['y']);
    expect(field(form, 'speed')?.value).toBe('fast');
    expect(field(form, 'terms')?.value).toBe(true);
  });

  it('clears a radio group when the saved value is empty', async () => {
    render(`
      <form>
        <input type="radio" name="speed" value="slow" /><input type="radio" name="speed" value="fast" checked />
      </form>
    `);

    const result = await fillDomForm(document, loc, 'dom:0', [{ path: 'speed', value: { $devkit: 'undefined' } }], false);

    expect(result.skipped).toEqual([]);
    expect(result.filled).toEqual(['speed']);
    const [form] = detectDomForms(document, loc);
    expect(field(form, 'speed')?.value).toBeNull();
  });

  it('fires input and change events so React sees the value', async () => {
    render(`<form><input name="email" /></form>`);
    const input = document.querySelector('input')!;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push(`input:${input.value}`));
    input.addEventListener('change', () => seen.push('change'));

    await fillDomForm(document, loc, 'dom:0', [{ path: 'email', value: 'a@b.fi' }], false);
    expect(seen).toEqual(['input:a@b.fi', 'change']);
  });

  it('fills a field that only appears after an earlier field changed', async () => {
    render(`<form><input name="hasAddress" type="checkbox" /></form>`);
    const form = document.querySelector('form')!;
    form.querySelector('input')!.addEventListener('change', () => {
      const extra = document.createElement('input');
      extra.name = 'street';
      form.appendChild(extra);
    });

    const result = await fillDomForm(
      document,
      loc,
      'dom:0',
      [
        { path: 'hasAddress', value: true },
        { path: 'street', value: 'Mannerheimintie 1' },
      ],
      false,
    );

    expect(result.filled).toEqual(['hasAddress', 'street']);
    expect(document.querySelector<HTMLInputElement>('[name=street]')!.value).toBe('Mannerheimintie 1');
  });

  it('reports fields that never show up and options that do not exist', async () => {
    render(`<form><select name="country"><option value="fi">Suomi</option></select></form>`);
    const result = await fillDomForm(
      document,
      loc,
      'dom:0',
      [
        { path: 'country', value: 'de' },
        { path: 'ghost', value: '1' },
      ],
      false,
    );

    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'country', reason: 'No option with value "de"' },
      { path: 'ghost', reason: 'Field not found on the page' },
    ]);
  });

  it('blurs the field when touching is asked for', async () => {
    render(`<form><input name="email" /></form>`);
    let blurred = false;
    document.querySelector('input')!.addEventListener('focusout', () => (blurred = true));
    await fillDomForm(document, loc, 'dom:0', [{ path: 'email', value: 'a@b.fi' }], true);
    expect(blurred).toBe(true);
  });
});
