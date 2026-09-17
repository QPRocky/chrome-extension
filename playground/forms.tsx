import { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  Field,
  FieldArray,
  change,
  formValueSelector,
  reduxForm,
  type InjectedFormProps,
  type WrappedFieldArrayProps,
  type WrappedFieldProps,
} from 'redux-form';

const FORM = 'application';

const CITIES: Record<string, string[]> = {
  fi: ['Helsinki', 'Tampere', 'Oulu'],
  se: ['Stockholm', 'Göteborg'],
  de: ['Berlin', 'München'],
};

interface Values {
  applicant?: string;
  email?: string;
  country?: string;
  city?: string;
  startDate?: string;
  contact?: string;
  hasAddress?: boolean;
  street?: string;
  notes?: string;
  items?: { code?: string; amount?: string }[];
}

type FieldProps = WrappedFieldProps & { label: string; type?: string };

/** redux-form's own selector and action types predate redux 5, hence the casts. */
function useFormValue<T>(field: string): T | undefined {
  return useSelector((state: object) => formValueSelector(FORM)(state, field) as T | undefined);
}

function Input({ input, meta, label, type = 'text' }: FieldProps) {
  return (
    <label style={{ display: 'block', margin: '4px 0' }}>
      {label} <input {...input} type={type} />
      {meta.touched && meta.error ? <em style={{ color: 'crimson' }}> {meta.error}</em> : null}
    </label>
  );
}

function Check({ input, label }: FieldProps) {
  return (
    <label style={{ display: 'block', margin: '4px 0' }}>
      <input type="checkbox" checked={Boolean(input.value)} onChange={input.onChange} /> {label}
    </label>
  );
}

function Choice({ input, label, options }: FieldProps & { options: string[] }) {
  return (
    <label style={{ display: 'block', margin: '4px 0' }}>
      {label}{' '}
      <select {...input}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Items({ fields }: WrappedFieldArrayProps<{ code?: string; amount?: string }>) {
  return (
    <div>
      {fields.map((name, index) => (
        <div key={name}>
          <Field name={`${name}.code`} component={Input} label={`Code ${index + 1}`} />
          <Field name={`${name}.amount`} component={Input} label="Amount" type="number" />
          <button type="button" onClick={() => fields.remove(index)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => fields.push({})}>
        Add row
      </button>
    </div>
  );
}

/**
 * Stands in for app logic that clears a dependent field: changing the country
 * empties the city. It reacts to the store, so it also runs when the extension
 * fills the form — which is what the Forms tab's after-fill check reports.
 */
function ResetCityOnCountryChange() {
  const country = useFormValue<string>('country');
  const dispatch = useDispatch();
  const previous = useRef(country);

  useEffect(() => {
    if (previous.current === country) return;
    previous.current = country;
    dispatch(change(FORM, 'city', '') as never);
  }, [country, dispatch]);

  return null;
}

function ApplicationFormBase({ handleSubmit, reset, submitting }: InjectedFormProps<Values>) {
  const country = useFormValue<string>('country');
  const hasAddress = useFormValue<boolean>('hasAddress');
  const [submitted, setSubmitted] = useState<Values | null>(null);

  return (
    <form onSubmit={handleSubmit((values) => setSubmitted(values))}>
      <ResetCityOnCountryChange />
      <Field name="applicant" component={Input} label="Applicant" />
      <Field name="email" component={Input} label="Email" type="email" />
      <Field name="startDate" component={Input} label="Start date" type="date" />
      <Field name="country" component={Choice} label="Country" options={Object.keys(CITIES)} />
      <Field name="city" component={Choice} label="City" options={CITIES[country ?? ''] ?? []} />
      <Field name="hasAddress" component={Check} label="I have a street address" />
      {hasAddress ? <Field name="street" component={Input} label="Street" /> : null}
      <div style={{ margin: '4px 0' }}>
        Contact by{' '}
        <label>
          <Field name="contact" component="input" type="radio" value="email" /> email
        </label>{' '}
        <label>
          <Field name="contact" component="input" type="radio" value="phone" /> phone
        </label>
      </div>
      <Field name="notes" component="textarea" placeholder="Notes" />
      <h3>Items</h3>
      <FieldArray name="items" component={Items} />
      <p>
        <button type="submit" disabled={submitting}>
          Submit
        </button>{' '}
        <button type="button" onClick={reset}>
          Reset
        </button>
      </p>
      {submitted ? <pre>{JSON.stringify(submitted, null, 2)}</pre> : null}
    </form>
  );
}

const ApplicationForm = reduxForm<Values>({
  form: FORM,
  initialValues: { country: 'fi', items: [{}] },
  validate: (values) => {
    const errors: Record<string, string> = {};
    if (!values.applicant) errors.applicant = 'Required';
    if (!values.email) errors.email = 'Required';
    else if (!values.email.includes('@')) errors.email = 'Must be an email address';
    return errors;
  },
})(ApplicationFormBase);

/** A form with no form library at all, for the Forms tab's DOM fallback. */
function PlainForm() {
  const [values, setValues] = useState({ fullName: '', role: 'dev', newsletter: false, comment: '' });
  const [saved, setSaved] = useState<typeof values | null>(null);
  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? (event.target as HTMLInputElement).checked : event.target.value }));

  return (
    <form
      name="plain"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(values);
      }}
    >
      <label style={{ display: 'block', margin: '4px 0' }}>
        Full name <input name="fullName" value={values.fullName} onChange={set('fullName')} />
      </label>
      <label style={{ display: 'block', margin: '4px 0' }}>
        Role{' '}
        <select name="role" value={values.role} onChange={set('role')}>
          <option value="dev">Developer</option>
          <option value="qa">Tester</option>
        </select>
      </label>
      <label style={{ display: 'block', margin: '4px 0' }}>
        <input type="checkbox" name="newsletter" checked={values.newsletter} onChange={set('newsletter')} /> Newsletter
      </label>
      <textarea name="comment" value={values.comment} onChange={set('comment')} placeholder="Comment" />
      <p>
        <button type="submit">Save</button>
      </p>
      {saved ? <pre>{JSON.stringify(saved, null, 2)}</pre> : null}
    </form>
  );
}

export function FormsPlayground() {
  return (
    <>
      <section>
        <h2>redux-form: application</h2>
        <p>
          Values live in <code>state.form.application</code>. Filling changes the country, which clears the city — the same dependent-field
          behaviour real apps have.
        </p>
        <ApplicationForm />
      </section>
      <section>
        <h2>Plain React form (DOM fallback)</h2>
        <PlainForm />
      </section>
    </>
  );
}
