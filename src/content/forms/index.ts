// Handles the `forms/*` requests from the panel in the page's MAIN world.
import type { FormRequestMap, FormRequestMethod } from '../../shared/messages';
import type { Registry, StoreRecord } from '../redux/registry';
import { DOM_PREFIX, detectDomForms, fillDomForm } from './dom';
import { RF_PREFIX, detectReduxForms, fillReduxForm } from './redux-form';

export class FormHandlers {
  constructor(private readonly registry: Registry) {}

  handle(method: FormRequestMethod, params: unknown): unknown {
    switch (method) {
      case 'forms/list':
        return this.list();
      case 'forms/fill':
        return this.fill(params as FormRequestMap['forms/fill']['params']);
    }
  }

  private list(): FormRequestMap['forms/list']['result'] {
    // Redux-form lives in the store, so a store found in the React tree is needed too.
    if (this.registry.size === 0) this.registry.handle('detect', undefined);
    return {
      forms: [...detectReduxForms(this.registry.records()), ...detectDomForms(document, location)],
      url: location.href,
    };
  }

  private fill(params: FormRequestMap['forms/fill']['params']): unknown {
    const { formId, entries, touch } = params;
    if (formId.startsWith(`${DOM_PREFIX}:`)) return fillDomForm(document, location, formId, entries, touch);

    const { record, formName } = this.reduxForm(formId);
    return fillReduxForm(record, formName, entries, touch);
  }

  /** Splits `rf:<storeId>:<form name>`; form names may contain colons. */
  private reduxForm(formId: string): { record: StoreRecord; formName: string } {
    const parts = formId.split(':');
    if (parts.shift() !== RF_PREFIX) throw new Error(`Unknown form: ${formId}`);
    const storeId = parts.shift();
    const formName = parts.join(':');
    const record = this.registry.records().find((candidate) => candidate.id === storeId);
    if (!record || !formName) throw new Error('That form is no longer available; refresh the form list');
    return { record, formName };
  }
}
