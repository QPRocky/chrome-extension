// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { combineReducers, createStore, type Store } from 'redux';
import { change, initialize, registerField, reducer as formReducer } from 'redux-form';
import { detectReduxForms, fillReduxForm, findFormRoot } from '../src/content/forms/redux-form';
import type { StoreRecord } from '../src/content/redux/registry';
import type { DetectedForm } from '../src/shared/messages';

function makeStore(mountKey = 'form'): Store {
  return createStore(combineReducers({ [mountKey]: formReducer, todos: () => ({ items: [] }) }));
}

/** redux-form's action types predate redux 5's UnknownAction, hence the cast. */
function send(store: Store, action: unknown): void {
  store.dispatch(action as never);
}

/** A store record as the registry hands it to the form handlers. */
function makeRecord(store: Store, id = 'store-1'): StoreRecord {
  return { id, name: 'Store', mode: 'hooked', inner: store, outer: store, history: [], pending: [], nextEntryId: 0, paused: false, jumpedTo: null } as unknown as StoreRecord;
}

function setupForm(mountKey = 'form') {
  const store = makeStore(mountKey);
  send(store, initialize('signup', { email: 'initial@example.com', items: [{ code: 'A' }] }));
  send(store, registerField('signup', 'email', 'Field'));
  send(store, registerField('signup', 'address.city', 'Field'));
  send(store, registerField('signup', 'items', 'FieldArray'));
  send(store, registerField('signup', 'items[0].code', 'Field'));
  return { store, record: makeRecord(store) };
}

function field(form: DetectedForm, path: string) {
  return form.fields.find((candidate) => candidate.path === path);
}

function values(store: Store, mountKey = 'form'): Record<string, unknown> {
  return (store.getState() as Record<string, Record<string, { values?: Record<string, unknown> }>>)[mountKey].signup.values ?? {};
}

describe('findFormRoot', () => {
  it('finds the reducer at the conventional key', () => {
    const { store } = setupForm();
    expect(findFormRoot(store.getState())?.mountKey).toBe('form');
  });

  it('finds the reducer mounted elsewhere, as getFormState allows', () => {
    const { store } = setupForm('reduxForms');
    expect(findFormRoot(store.getState())?.mountKey).toBe('reduxForms');
  });

  it('returns null for a state without forms', () => {
    expect(findFormRoot({ todos: { items: [] } })).toBeNull();
    expect(findFormRoot(null)).toBeNull();
  });
});

describe('detectReduxForms', () => {
  it('lists registered fields and leaves FieldArray children out', () => {
    const { record } = setupForm();
    const [form] = detectReduxForms([record]);

    expect(form.name).toBe('signup');
    expect(form.id).toBe('rf:store-1:signup');
    expect(form.fields.map((f) => f.path)).toEqual(['email', 'address.city', 'items']);
    expect(field(form, 'items')?.kind).toBe('FieldArray');
    expect(field(form, 'items')?.value).toEqual([{ code: 'A' }]);
  });

  it('marks fields that differ from the initial values', () => {
    const { store, record } = setupForm();
    send(store, change('signup', 'address.city', 'Helsinki'));

    const [form] = detectReduxForms([record]);
    expect(field(form, 'email')?.dirty).toBe(false);
    expect(field(form, 'address.city')?.dirty).toBe(true);
  });

  it('skips forms with no fields on screen', () => {
    const store = makeStore();
    send(store, initialize('leftover', { email: 'x' }));
    expect(detectReduxForms([makeRecord(store)])).toEqual([]);
  });
});

describe('fillReduxForm', () => {
  it('writes values through redux-form change actions', () => {
    const { store, record } = setupForm();

    const result = fillReduxForm(
      record,
      'signup',
      [
        { path: 'email', value: 'filled@example.com' },
        { path: 'address.city', value: 'Tampere' },
        { path: 'items', value: [{ code: 'B' }, { code: 'C' }] },
      ],
      false,
    );

    expect(result.filled).toEqual(['email', 'address.city', 'items']);
    expect(result.skipped).toEqual([]);
    expect(values(store)).toEqual({
      email: 'filled@example.com',
      address: { city: 'Tampere' },
      items: [{ code: 'B' }, { code: 'C' }],
    });
  });

  it('keeps values of fields that are not registered yet', () => {
    const { store, record } = setupForm();
    fillReduxForm(record, 'signup', [{ path: 'phone', value: '040 1234567' }], false);
    expect(values(store).phone).toBe('040 1234567');
  });

  it('touches the filled fields when asked, so validation shows', () => {
    const { store, record } = setupForm();
    fillReduxForm(record, 'signup', [{ path: 'email', value: 'a@b.fi' }], true);

    const form = (store.getState() as Record<string, Record<string, { fields?: Record<string, { touched?: boolean }>; anyTouched?: boolean }>>).form.signup;
    expect(form.fields?.email?.touched).toBe(true);
    expect(form.anyTouched).toBe(true);
  });

  it('revives serialized values such as dates', () => {
    const { store, record } = setupForm();
    fillReduxForm(record, 'signup', [{ path: 'startDate', value: { $devkit: 'Date', value: '2026-09-17T09:00:00.000Z' } }], false);
    expect(values(store).startDate).toEqual(new Date('2026-09-17T09:00:00.000Z'));
  });
});
