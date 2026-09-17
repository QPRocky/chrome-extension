// @vitest-environment jsdom
// Smoke test for the playground's forms: catches a redux-form or React upgrade
// that breaks the app the Forms tab is developed against.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { combineReducers, createStore } from 'redux';
import { reducer as formReducer } from 'redux-form';
import { expect, it } from 'vitest';
import { FormsPlayground } from '../playground/forms';

it('renders the redux-form and plain forms', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const store = createStore(combineReducers({ form: formReducer }));
  act(() => {
    createRoot(container).render(
      <Provider store={store}>
        <FormsPlayground />
      </Provider>,
    );
  });
  const names = [...container.querySelectorAll('input,select,textarea')].map((el) => (el as HTMLInputElement).name);
  expect(names).toContain('applicant');
  expect(names).toContain('items[0].code');
  expect(names).toContain('fullName');
});
