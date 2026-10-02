import type { PineInputMeta, PinePropMeta, PineValidation, PineValue } from '@pineterm/contracts';

export function PineSettings({ validation, inputs, props, onInputs, onProps }: { validation: PineValidation | null; inputs: Record<string, PineValue>; props: Record<string, PineValue>; onInputs: (values: Record<string, PineValue>) => void; onProps: (values: Record<string, PineValue>) => void }) {
  if (!validation?.valid) return <p className="muted">Validate this Pine source to discover its input and declaration settings.</p>;
  const field = (meta: PineInputMeta | PinePropMeta, key: string, values: Record<string, PineValue>, change: (values: Record<string, PineValue>) => void) => {
    const input = 'id' in meta;
    const title = input ? meta.title ?? meta.name : meta.name;
    const type = meta.type.replace(/^input\./, '').toLowerCase();
    const defval = meta.defval;
    const supported = typeof defval === 'string' || typeof defval === 'number' || typeof defval === 'boolean';
    const override = Object.hasOwn(values, key);
    const value = override ? values[key]! : supported ? defval as PineValue : '';
    const set = (next: PineValue) => change({ ...values, [key]: next });
    const unset = () => { const next = { ...values }; delete next[key]; change(next); };
    const identifier = `${input ? 'input' : 'prop'}-${key}`;
    const numeric = ['int', 'integer', 'float', 'number', 'time'].includes(type) || typeof value === 'number';
    return <div className="pine-setting" key={identifier} title={input ? meta.tooltip : undefined}>
      <label className="pine-override"><input type="checkbox" checked={override} disabled={!supported || (input && meta.active === false)} onChange={(event) => { if (event.target.checked) set(defval as PineValue); else unset(); }} />Override {title}<code>{key}</code></label>
      {!supported ? <small>Runtime-only default; this control cannot override its structured value.</small> : meta.options?.length ? <select aria-label={`${title} · ${key}`} disabled={!override} value={JSON.stringify(value)} onChange={(event) => set(JSON.parse(event.target.value) as PineValue)}>{meta.options.filter((option) => ['string', 'number', 'boolean'].includes(typeof option)).map((option, index) => <option key={index} value={JSON.stringify(option)}>{String(option)}</option>)}</select> : type === 'bool' || type === 'boolean' || typeof value === 'boolean' ? <select aria-label={`${title} · ${key}`} disabled={!override} value={String(value)} onChange={(event) => set(event.target.value === 'true')}><option value="true">True</option><option value="false">False</option></select> : <input aria-label={`${title} · ${key}`} type={numeric ? 'number' : 'text'} disabled={!override} value={String(value)} min={meta.minval} max={meta.maxval} step={'step' in meta ? meta.step ?? (type === 'int' ? 1 : 'any') : 'any'} onChange={(event) => { if (numeric) { if (event.target.value !== '' && Number.isFinite(Number(event.target.value))) set(Number(event.target.value)); } else set(event.target.value); }} />}
      <small>Declaration / runtime default: {JSON.stringify(defval)}</small>
    </div>;
  };
  return <div className="pine-settings"><p>Precedence: explicit overrides → source declaration → PineTS runtime default. Unchecked controls do not submit hidden defaults. Duplicate titles use independent variable/declaration IDs.</p><fieldset><legend>Inputs</legend>{validation.inputs.length ? validation.inputs.map((meta) => field(meta, meta.varId ?? meta.id, inputs, onInputs)) : <p>No declared inputs.</p>}</fieldset><fieldset><legend>{validation.declarationType === 'strategy' ? 'Strategy properties' : 'Indicator properties'}</legend>{validation.props.filter((meta) => meta.mutable && (meta.appliesTo === 'both' || meta.appliesTo === validation.declarationType || meta.appliesTo === 'all')).map((meta) => field(meta, meta.name, props, onProps))}</fieldset></div>;
}
