import { useEffect, useRef, useState } from 'react';
import type { AgentDraft, AppliedAgentDraft, PineValue } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';
import { Modal } from '../../Modal.js';
import { PineEditor } from '../scripts/PineEditor.js';
import { PineSettings } from '../scripts/PineSettings.js';

// A contiguous changed region keeps large drafts bounded while exposing every changed line.
function sourceDiff(base: string | null, source: string): { before: string; after: string; prefix: number; suffix: number } {
  const before = (base ?? '').split('\n'); const after = source.split('\n');
  let prefix = 0; let suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  return { before: before.slice(prefix, before.length - suffix).map(line => `− ${line}`).join('\n'), after: after.slice(prefix, after.length - suffix).map(line => `+ ${line}`).join('\n'), prefix, suffix };
}

export function AgentDraftPanel({ client, draftId, onClose, onApplied, onUpdated, onSessionError }: {
  client: ApiClient; draftId: string; onClose: () => void; onApplied: (value: AppliedAgentDraft) => void; onUpdated: () => void; onSessionError: (failure: ApiError) => void;
}) {
  const [draft, setDraft] = useState<AgentDraft | null>(null); const [name, setName] = useState(''); const [source, setSource] = useState('');
  const [inputs, setInputs] = useState<Record<string, PineValue>>({}); const [props, setProps] = useState<Record<string, PineValue>>({});
  const [mode, setMode] = useState<'new' | 'update'>('new'); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null); const [conflict, setConflict] = useState(false);
  const operation = useRef<AbortController | null>(null); const inFlight = useRef(false);
  const fail = (failure: unknown) => { if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) onSessionError(failure); setError(errorMessage(failure)); };
  function restore(value: AgentDraft) { setDraft(value); setName(value.name); setSource(value.source); setInputs(value.inputs); setProps(value.props); setConflict(false); }
  useEffect(() => {
    const controller = new AbortController();
    void client.request<{ draft: AgentDraft }>(`/agent/drafts/${encodeURIComponent(draftId)}`, { signal: controller.signal }).then(({ draft: value }) => { if (!controller.signal.aborted) { restore(value); setMode(value.scriptId ? 'update' : 'new'); } }).catch(failure => { if (!controller.signal.aborted) fail(failure); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); operation.current?.abort(); };
  }, [client, draftId]);
  const dirty = !!draft && (source !== draft.source || name !== draft.name || JSON.stringify(inputs) !== JSON.stringify(draft.inputs) || JSON.stringify(props) !== JSON.stringify(draft.props));
  async function command(kind: 'save' | 'validate' | 'apply' | 'reload') {
    if (inFlight.current || !draft) return;
    if (kind === 'reload' && dirty && !window.confirm('Discard local draft edits and reload the server draft?')) return;
    if (kind === 'apply' && !window.confirm(mode === 'new' ? `Create a new saved script named “${name.trim()}”? This does not run it or arm an alert.` : `Create a new immutable revision of the draft’s base script named “${name.trim()}”? The server rejects a changed base head. This does not run it or arm an alert.`)) return;
    inFlight.current = true; setBusy(true); setError(null); setNotice(null);
    const controller = new AbortController(); operation.current = controller;
    try {
      let value = draft;
      if (kind === 'reload') {
        const result = await client.request<{ draft: AgentDraft }>(`/agent/drafts/${encodeURIComponent(draftId)}`, { signal: controller.signal });
        restore(result.draft); setNotice('Reloaded the server draft.'); return;
      }
      if (dirty) {
        const result = await client.request<{ draft: AgentDraft }>(`/agent/drafts/${encodeURIComponent(draftId)}`, { method: 'PUT', csrf: true, body: { revision: draft.revision, name: name.trim(), source, inputs, props }, signal: controller.signal });
        value = result.draft; restore(value); onUpdated();
      }
      if (kind === 'validate') {
        const result = await client.request<{ draft: AgentDraft }>(`/agent/drafts/${encodeURIComponent(draftId)}/validate`, { method: 'POST', csrf: true, body: { revision: value.revision }, signal: controller.signal });
        restore(result.draft); onUpdated(); setNotice(result.draft.validation?.valid ? 'Current draft validated in the isolated runner. Review the diff, then explicitly Apply.' : 'Validation failed. Source stays editable; no script revision was applied.');
      } else if (kind === 'apply') {
        const result = await client.request<AppliedAgentDraft>(`/agent/drafts/${encodeURIComponent(draftId)}/apply`, { method: 'POST', csrf: true, body: { revision: value.revision, mode, name: name.trim() }, signal: controller.signal });
        restore(result.draft); onUpdated(); onApplied(result); onClose();
      } else setNotice('Draft saved with revision protection. Validate the current source before Apply.');
    } catch (failure) { if (!controller.signal.aborted) { if (failure instanceof ApiError && failure.status === 409) setConflict(true); fail(failure); } }
    finally { if (!controller.signal.aborted) setBusy(false); inFlight.current = false; operation.current = null; }
  }
  const diff = sourceDiff(draft?.baseSource ?? null, source);
  return <Modal title="Review Pi Pine draft" titleId="agent-draft-title" onClose={() => { if (!dirty || window.confirm('Close without saving local Pine draft edits?')) onClose(); }} closeDisabled={busy}>
    <div className="agent-draft-panel">
      <div className="agent-boundary"><strong>Draft → isolated validation → diff → user Apply</strong><span>No automatic chart execution, active alert update or trading authority. Generated strategies are not a claim of profitability or safety.</span></div>
      {loading && <p role="status">Loading server-owned draft…</p>}
      {error && <p className="message error" role="alert">{error}{conflict && <small>Local source is preserved. Reload only if you choose to discard it; a changed base script cannot be force-overwritten. Apply as a new script is available only after reloading and validating the current draft.</small>}</p>}
      {notice && <p role="status">{notice}</p>}
      {draft && <>
        <div className="agent-draft-controls"><label>Script name<input value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={busy || !!draft.appliedRevisionId} /></label><label>Apply mode<select value={mode} onChange={event => setMode(event.target.value as typeof mode)} disabled={busy || !!draft.appliedRevisionId}><option value="new">New saved script</option><option value="update" disabled={!draft.scriptId}>Update base script · head CAS</option></select></label></div>
        <p className="muted">Draft r{draft.revision} · {dirty ? 'local unsaved edits' : 'saved source'}{draft.baseRevisionId ? ` · base revision ${draft.baseRevisionId}` : ' · no base script'}{draft.appliedRevisionId ? ` · applied revision ${draft.appliedRevisionId}` : ''}</p>
        <div className="agent-draft-editor"><PineEditor source={source} documentKey={draft.id} readOnly={busy || !!draft.appliedRevisionId} onChange={setSource} /></div>
        <details><summary>Input / property overrides</summary><fieldset disabled={busy || !!draft.appliedRevisionId}><PineSettings validation={draft.validation} inputs={inputs} props={props} onInputs={setInputs} onProps={setProps} /></fieldset></details>
        <details open><summary>Source diff · {draft.baseSource === null ? 'new file' : 'immutable base → proposed source'}</summary><p className="muted">{diff.prefix} unchanged leading lines · {diff.suffix} unchanged trailing lines. Full proposed source is editable above.</p><div className="agent-diff"><pre className="agent-diff-before">{diff.before || '(no removed lines)'}</pre><pre className="agent-diff-after">{diff.after || '(no added lines)'}</pre></div>{draft.baseSource !== null && <details><summary>Full immutable base source</summary><pre>{draft.baseSource}</pre></details>}</details>
        <div className="agent-validation" role="status">{dirty ? 'Edits are not yet validated.' : draft.validation ? draft.validation.valid ? `Validated ${draft.validation.declarationType} · isolated runner` : 'Validation failed · source remains editable' : 'Not validated'}</div>
        {draft.diagnostics.map((diagnostic, index) => <p className="pine-diagnostic" role="alert" key={index}>{diagnostic.code}: {diagnostic.message}{diagnostic.line === undefined ? '' : ` · line ${diagnostic.line}`}{diagnostic.column === undefined ? '' : `:${diagnostic.column}`}</p>)}
        {draft.validation?.warnings?.map((warning, index) => <p className="pine-limitations" key={index}>{warning.message}</p>)}
        <div className="compact-actions"><button type="button" disabled={busy || conflict || !dirty || !!draft.appliedRevisionId || !name.trim()} onClick={() => void command('save')}>Save draft edits</button><button type="button" disabled={busy || conflict || !!draft.appliedRevisionId || !name.trim()} onClick={() => void command('validate')}>{busy ? 'Runner / server working…' : 'Validate current draft'}</button><button type="button" className="primary" disabled={busy || conflict || dirty || !draft.validation?.valid || !name.trim() || !!draft.appliedRevisionId || (mode === 'update' && !draft.scriptId)} onClick={() => void command('apply')}>Apply to {mode === 'new' ? 'new script' : 'base script'} & open editor</button><button type="button" disabled={busy} onClick={() => void command('reload')}>Reload server draft</button></div>
        <p className="muted">Apply saves an immutable revision and opens the Pine editor. Use Strategy Tester to choose the market and UTC range before running a PineTS simulation. Existing alerts keep their selected immutable revisions.</p>
      </>}
    </div>
  </Modal>;
}
