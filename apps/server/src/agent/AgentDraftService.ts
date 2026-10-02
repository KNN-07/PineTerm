import { randomUUID } from 'node:crypto';
import type { AgentDraft, AppliedAgentDraft, ApplyAgentDraft, PineDiagnostic, PineValidation, PineValue, ProposeAgentDraft, ScriptRecord, UpdateAgentDraft } from '@pineterm/contracts';
import type { AppDatabase } from '../database.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';
import type { PineService } from '../pine/PineService.js';
import { pineHash } from '../pine/PineService.js';
import { MAX_PINE_BYTES, type ScriptService } from '../scripts/ScriptService.js';

interface DraftRow {
  id: string; session_id: string; name: string; revision: number; source: string; script_id: string | null;
  base_revision_id: string | null; diagnostic_json: string | null; inputs_json: string; props_json: string;
  validation_hash: string | null; apply_hash: string | null; applied_revision_id: string | null; created_at: number; updated_at: number;
}
interface ValidationState { validation: PineValidation | null; diagnostics: PineDiagnostic[]; appliedScript?: ScriptRecord }
export function checkDraftContent(body: { name: string; source: string; inputs: Record<string, PineValue>; props: Record<string, PineValue> }): void {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) throw new ApiError(400, 'INVALID_NAME', 'Draft name must contain 1–100 characters.');
  if (typeof body.source !== 'string' || !body.source.length || Buffer.byteLength(body.source, 'utf8') > MAX_PINE_BYTES) throw new ApiError(400, 'INVALID_SOURCE', 'Supply nonempty Pine text up to 256 KiB UTF-8. Invalid Pine remains editable until corrected.');
  for (const values of [body.inputs, body.props]) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 256 || Object.entries(values).some(([key, value]) => !key || key.length > 200 || ['__proto__', 'prototype', 'constructor'].includes(key) || !(typeof value === 'boolean' || typeof value === 'string' && value.length <= 4096 || typeof value === 'number' && Number.isFinite(value)))) throw new ApiError(400, 'INVALID_OVERRIDES', 'Use bounded, named string/finite-number/boolean Pine overrides.');
  }
}
function contentHash(draft: Pick<AgentDraft, 'source' | 'inputs' | 'props'>): string { return pineHash({ source: draft.source, inputs: draft.inputs, props: draft.props }); }
function assertRevision(revision: number, actual: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new ApiError(400, 'INVALID_REVISION', 'Supply a positive draft revision.');
  if (revision !== actual) throw new ApiError(409, 'DRAFT_REVISION_CONFLICT', 'The draft changed. Reload it before validating or applying.', { currentRevision: actual });
}

/** Agent proposals are isolated editable records. Only the authenticated user Apply route publishes a revision. */
export class AgentDraftService {
  constructor(private readonly db: AppDatabase, private readonly pine: PineService, private readonly scripts: ScriptService, private readonly clock: () => number, _events: InvalidationHub) {}
  #session(id: string): void {
    if (!this.db.prepare('SELECT id FROM agent_sessions WHERE id=? AND archived_at IS NULL').get(id)) throw new ApiError(404, 'AGENT_SESSION_NOT_FOUND', 'The agent session does not exist.');
  }
  #row(id: string): DraftRow {
    const row = this.db.prepare<[string], DraftRow>('SELECT * FROM agent_drafts WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'AGENT_DRAFT_NOT_FOUND', 'The proposed script draft does not exist.');
    return row;
  }
  #view(row: DraftRow): AgentDraft {
    const stored: ValidationState = row.diagnostic_json ? JSON.parse(row.diagnostic_json) : { validation: null, diagnostics: [] };
    return { id: row.id, sessionId: row.session_id, name: row.name, revision: row.revision, source: row.source,
      baseSource: row.base_revision_id ? this.scripts.getRevision(row.base_revision_id).source : null, scriptId: row.script_id, baseRevisionId: row.base_revision_id,
      inputs: JSON.parse(row.inputs_json), props: JSON.parse(row.props_json), validation: stored.validation, diagnostics: stored.diagnostics,
      appliedRevisionId: row.applied_revision_id, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  get(id: string): AgentDraft { return this.#view(this.#row(id)); }
  list(sessionId: string): AgentDraft[] {
    this.#session(sessionId);
    return this.db.prepare<[string], DraftRow>('SELECT * FROM agent_drafts WHERE session_id=? ORDER BY created_at,id').all(sessionId).map(row => this.#view(row));
  }
  async propose(sessionId: string, body: ProposeAgentDraft, signal?: AbortSignal): Promise<AgentDraft> {
    const inputs = body.inputs ?? {}; const props = body.props ?? {};
    checkDraftContent({ ...body, inputs, props }); signal?.throwIfAborted();
    const id = randomUUID(); const now = this.clock();
    this.db.transaction(() => {
      this.#session(sessionId);
      const count = this.db.prepare<[string], { count: number }>('SELECT count(*) AS count FROM agent_drafts WHERE session_id=?').get(sessionId)!.count;
      if (count >= 100) throw new ApiError(429, 'AGENT_DRAFT_LIMIT', 'This session has 100 drafts. Start a new analysis session.');
      const base = body.baseRevisionId ? this.scripts.getRevision(body.baseRevisionId) : null;
      this.db.prepare('INSERT INTO agent_drafts(id,session_id,name,revision,source,script_id,base_revision_id,inputs_json,props_json,created_at,updated_at) VALUES (?,?,?,1,?,?,?,?,?,?,?)').run(id, sessionId, body.name.trim(), body.source, base?.scriptId ?? null, base?.id ?? null, JSON.stringify(inputs), JSON.stringify(props), now, now);
    }).immediate();
    return this.validate(id, 1, signal);
  }
  update(id: string, body: UpdateAgentDraft): AgentDraft {
    checkDraftContent(body);
    return this.db.transaction(() => {
      const row = this.#row(id); assertRevision(body.revision, row.revision);
      if (row.applied_revision_id) throw new ApiError(409, 'DRAFT_ALREADY_APPLIED', 'This draft was applied. Propose a new draft to make further changes.');
      const hash = contentHash(body);
      const preserve = row.validation_hash === hash;
      const changed = this.db.prepare('UPDATE agent_drafts SET name=?,source=?,inputs_json=?,props_json=?,revision=revision+1,diagnostic_json=?,validation_hash=?,updated_at=? WHERE id=? AND revision=? AND applied_revision_id IS NULL').run(body.name.trim(), body.source, JSON.stringify(body.inputs), JSON.stringify(body.props), preserve ? row.diagnostic_json : null, preserve ? row.validation_hash : null, this.clock(), id, body.revision);
      if (changed.changes !== 1) throw new ApiError(409, 'DRAFT_REVISION_CONFLICT', 'The draft changed before this edit.');
      return this.get(id);
    }).immediate();
  }
  async validate(id: string, revision: number, signal?: AbortSignal): Promise<AgentDraft> {
    const row = this.#row(id); assertRevision(revision, row.revision); signal?.throwIfAborted();
    if (row.applied_revision_id) return this.#view(row);
    const draft = this.#view(row); const hash = contentHash(draft);
    let validation: PineValidation | null = null; let diagnostics: PineDiagnostic[] = []; let failure: unknown;
    try { validation = await this.pine.validate(draft.source, draft.inputs, draft.props, signal); diagnostics = validation.diagnostics; signal?.throwIfAborted(); }
    catch (error) {
      failure = error;
      diagnostics = [{ code: signal?.aborted ? 'CANCELLED' : error instanceof ApiError ? error.code : 'PINE_VALIDATION_FAILED', message: signal?.aborted ? 'Validation was cancelled; validate again before Apply.' : error instanceof ApiError ? error.message : 'The isolated Pine runner could not validate this draft.' }];
    }
    const saved = this.db.transaction(() => {
      const current = this.#row(id); assertRevision(revision, current.revision);
      if (current.applied_revision_id) return this.#view(current);
      if (contentHash(this.#view(current)) !== hash) throw new ApiError(409, 'DRAFT_REVISION_CONFLICT', 'The draft changed during validation.');
      this.db.prepare('UPDATE agent_drafts SET diagnostic_json=?,validation_hash=?,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify({ validation, diagnostics }), validation ? hash : null, this.clock(), id, revision);
      return this.get(id);
    }).immediate();
    if (failure) throw failure;
    return saved;
  }
  async apply(id: string, body: ApplyAgentDraft): Promise<AppliedAgentDraft> {
    if (!['new', 'update'].includes(body.mode) || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) throw new ApiError(400, 'INVALID_APPLY', 'Choose new/update and an explicit script name of 1–100 characters.');
    return this.db.transaction(() => {
      const row = this.#row(id); assertRevision(body.revision, row.revision);
      const draft = this.#view(row); const hash = contentHash(draft); const commandHash = pineHash({ revision: body.revision, mode: body.mode, name: body.name.trim(), contentHash: hash });
      if (row.applied_revision_id) {
        if (row.apply_hash !== commandHash) throw new ApiError(409, 'DRAFT_ALREADY_APPLIED', 'This draft was applied with a different command.');
        const revision = this.scripts.getRevision(row.applied_revision_id);
        const stored = JSON.parse(row.diagnostic_json!) as ValidationState;
        if (!stored.appliedScript) throw new ApiError(409, 'DRAFT_APPLY_RECORD_MISSING', 'The original Apply record is unavailable.');
        return { draft, revision, script: stored.appliedScript };
      }
      if (row.validation_hash !== hash || !draft.validation?.valid) throw new ApiError(409, 'DRAFT_VALIDATION_REQUIRED', 'Validate the current draft successfully in the isolated runner before Apply.', { diagnostics: draft.diagnostics });
      const create = { name: body.name.trim(), source: draft.source, inputs: draft.inputs, props: draft.props };
      let published;
      if (body.mode === 'new') published = this.scripts.create(create);
      else {
        if (!draft.scriptId || !draft.baseRevisionId) throw new ApiError(409, 'DRAFT_BASE_REQUIRED', 'This draft has no selected base script. Save it as a new script.');
        const current = this.scripts.get(draft.scriptId).script;
        if (current.archivedAt !== null) throw new ApiError(409, 'SCRIPT_ARCHIVED', 'The base script is archived. Save this draft as new instead.');
        if (current.currentRevisionId !== draft.baseRevisionId) throw new ApiError(409, 'SCRIPT_HEAD_CONFLICT', 'The base script changed after this proposal. Reload it or save this draft as new.');
        published = this.scripts.update(draft.scriptId, { ...create, revision: current.revision });
      }
      const stored = JSON.parse(row.diagnostic_json!) as ValidationState;
      this.db.prepare('UPDATE agent_drafts SET applied_revision_id=?,apply_hash=?,diagnostic_json=?,updated_at=? WHERE id=? AND revision=? AND applied_revision_id IS NULL').run(published.revision.id, commandHash, JSON.stringify({ ...stored, appliedScript: published.script }), this.clock(), id, body.revision);
      return { draft: this.get(id), ...published };
    }).immediate();
  }
}
