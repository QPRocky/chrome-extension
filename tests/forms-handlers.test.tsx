// @vitest-environment jsdom
// End-to-end check of the page side: a real redux-form form rendered with React,
// listed and filled through the handlers the panel talks to.
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { combineReducers, createStore, type Store } from 'redux';
import { Field, FieldArray, change, formValueSelector, reducer as formReducer, reduxForm, type WrappedFieldArrayProps } from 'redux-form';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FormHandlers } from '../src/content/forms';
import { Registry } from '../src/content/redux/registry';
import type { ReduxStore } from '../src/content/redux/types';
import type { DetectedForm, FormRequestMap } from '../src/shared/messages';

const FORM = 'signup';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function useValue<T>(field: string): T | undefined {
  return useSelector((state: object) => formValueSelector(FORM)(state, field) as T | undefined);
}

function Items({ fields }: WrappedFieldArrayProps<{ code?: string }>) {
  return (
    <div>
      {fields.map((name) => (
        <Field key={name} name={`${name}.code`} component="input" />
      ))}
    </div>
  );
}

/** App logic that clears the city whenever the country changes. */
function ResetCity() {
  const country = useValue<string>('country');
  const dispatch = useDispatch();
  const previous = useRef(country);
  useEffect(() => {
    if (previous.current === country) return;
    previous.current = country;
    dispatch(change(FORM, 'city', '') as never);
  }, [country, dispatch]);
  return null;
}

function Fields() {
  const hasAddress = useValue<boolean>('hasAddress');
  return (
    <form>
      <ResetCity />
      <Field name="email" component="input" />
      <Field name="city" component="input" />
      <Field name="hasAddress" component="input" type="checkbox" />
      {/* Only rendered once the checkbox is on, like a conditional section. */}
      {hasAddress ? <Field name="street" component="input" /> : null}
      <Field name="country" component="select">
        <option value="fi">Suomi</option>
        <option value="se">Ruotsi</option>
      </Field>
      <FieldArray name="items" component={Items} />
    </form>
  );
}

const SignupForm = reduxForm({ form: FORM, initialValues: { country: 'fi', items: [{ code: 'A' }] } })(Fields);

let root: Root;
let container: HTMLDivElement;
let store: Store;
let handlers: FormHandlers;

function list(): DetectedForm[] {
  return (handlers.handle('forms/list', undefined) as FormRequestMap['forms/list']['result']).forms;
}

function input(name: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`[name="${name}"]`);
}

/** Values of the inputs the FieldArray rendered, in order. */
function arrayInputs(): string[] {
  return [...container.querySelectorAll('input')].filter((el) => el.name.startsWith('items[')).map((el) => el.value);
}

function value(form: DetectedForm, path: string): unknown {
  return form.fields.find((field) => field.path === path)?.value;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);

  store = createStore(combineReducers({ form: formReducer }));
  const registry = new Registry({ emit: () => undefined, schedule: (fn) => fn() });
  // The hook's store type is structural; redux 5's own type is narrower.
  registry.registerLimited(store as unknown as ReduxStore, 'Store');
  handlers = new FormHandlers(registry);

  act(() => {
    root = createRoot(container);
    root.render(
      <Provider store={store}>
        <SignupForm />
      </Provider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('forms/list', () => {
  it('reports the redux-form form with the fields that are mounted', () => {
    const forms = list();
    const redux = forms.find((form) => form.kind === 'redux-form')!;

    expect(redux.id).toBe('rf:store-1:signup');
    expect(redux.fields.map((field) => field.path)).toEqual(['email', 'city', 'hasAddress', 'country', 'items']);
    expect(value(redux, 'country')).toBe('fi');
    expect(value(redux, 'items')).toEqual([{ code: 'A' }]);
  });

  it('also sees the same inputs through the DOM fallback', () => {
    const dom = list().find((form) => form.kind === 'dom')!;
    expect(dom.fields.map((field) => field.path)).toContain('email');
  });
});

describe('forms/fill', () => {
  it('fills the form, including a field that is only rendered later', async () => {
    const forms = list();
    const redux = forms.find((form) => form.kind === 'redux-form')!;

    await act(async () => {
      await handlers.handle('forms/fill', {
        formId: redux.id,
        entries: [
          { path: 'email', value: 'filled@example.com' },
          { path: 'hasAddress', value: true },
          { path: 'street', value: 'Mannerheimintie 1' },
          { path: 'items', value: [{ code: 'B' }, { code: 'C' }] },
        ],
        touch: false,
      });
    });

    expect(input('email')?.value).toBe('filled@example.com');
    expect(input('hasAddress')?.checked).toBe(true);
    // The conditional field mounted after the fill and picked up its value.
    expect(input('street')?.value).toBe('Mannerheimintie 1');
    expect(arrayInputs()).toEqual(['B', 'C']);
  });

  it('shows up as an unapplied field when the app resets a dependent value', async () => {
    const redux = list().find((form) => form.kind === 'redux-form')!;

    await act(async () => {
      await handlers.handle('forms/fill', {
        formId: redux.id,
        entries: [
          { path: 'country', value: 'se' },
          { path: 'city', value: 'Stockholm' },
        ],
        touch: false,
      });
    });

    const after = list().find((form) => form.kind === 'redux-form')!;
    expect(value(after, 'country')).toBe('se');
    // redux-form dropped the value again, which is what the panel reports as unapplied.
    expect(value(after, 'city')).not.toBe('Stockholm');
    expect(input('city')?.value).toBe('');
  });
});
