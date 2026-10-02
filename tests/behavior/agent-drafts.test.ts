import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { FIXTURE_START, FixtureTransport } from '../fixtures/market.js';
import { SMA_SOURCE } from '../fixtures/pine.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function draftApp() {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-agent-drafts-'));
  const clock = () => FIXTURE_START + 360000;
  const config = loadConfig({ PINETERM_ADMIN_PASSWORD: 'draft-test-password', PINETERM_SESSION_SECRET: randomBytes(48).toString('base64'), PINETERM_SECRET_KEY: randomBytes(32).toString('base64'), PINETERM_DATA_DIR: directory, PINETERM_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' });
  const app = await buildApp({ config, providers: { coinbase: new FixtureTransport('coinbase', clock) }, clock });
  cleanups.push(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const id = randomUUID();
  app.db.prepare('INSERT INTO agent_sessions(id,storage_id,title,model_provider,model_id,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, randomUUID(), 'Draft boundary fixture', 'unconfigured', 'unconfigured', '{}', clock(), clock());
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { origin: config.publicOrigin }, payload: { password: config.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], origin: config.publicOrigin, 'x-csrf-token': login.json().csrfToken };
  return { app, id, headers, drafts: app.services.agentDrafts };
}

describe('agent draft publication boundary', () => {
  it('keeps invalid proposals editable and requires successful current real-runner validation before user Apply', async () => {
    const { app, id, drafts, headers } = await draftApp();
    const base = app.services.scripts.create({ name: 'Selected base', source: SMA_SOURCE, inputs: {}, props: {} });
    const beforeScripts = app.services.scripts.list(); const beforePolicy = app.services.execution.getPolicy();
    const invalid = await drafts.propose(id, { name: 'Editable error', source: '//@version=6\nindicator("Invalid")\nplot(', baseRevisionId: base.revision.id });
    expect(invalid.validation?.valid).toBe(false);
    expect(invalid.baseSource).toBe(SMA_SOURCE);
    expect(app.services.scripts.list()).toEqual(beforeScripts);
    expect(app.services.execution.getPolicy()).toEqual(beforePolicy);
    const failedApply = await app.inject({ method: 'POST', url: `/api/v1/agent/drafts/${invalid.id}/apply`, headers, payload: { revision: invalid.revision, mode: 'update', name: 'Explicit update' } });
    expect(failedApply.statusCode).toBe(409);
    const edited = await app.inject({ method: 'PUT', url: `/api/v1/agent/drafts/${invalid.id}`, headers, payload: { revision: invalid.revision, name: 'Corrected', source: SMA_SOURCE.replace('input.int(2', 'input.int(3'), inputs: { length: 4 }, props: {} } });
    expect(edited.statusCode).toBe(200);
    const current = edited.json().draft;
    expect(current.validation).toBeNull(); expect(current.diagnostics).toEqual([]);
    await expect(drafts.apply(current.id, { revision: current.revision, mode: 'update', name: 'Explicit update' })).rejects.toMatchObject({ code: 'DRAFT_VALIDATION_REQUIRED' });
    expect(app.services.scripts.get(base.script.id).revision.id).toBe(base.revision.id);
    const validated = await app.inject({ method: 'POST', url: `/api/v1/agent/drafts/${current.id}/validate`, headers, payload: { revision: current.revision } });
    expect(validated.statusCode).toBe(200); expect(validated.json().draft.validation.valid).toBe(true);
    const applied = await app.inject({ method: 'POST', url: `/api/v1/agent/drafts/${current.id}/apply`, headers, payload: { revision: current.revision, mode: 'update', name: 'Explicit update' } });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().revision).toMatchObject({ revision: 2, inputs: { length: 4 }, source: current.source });
    expect(app.services.scripts.getRevision(base.revision.id).source).toBe(SMA_SOURCE);
    expect(app.services.execution.getPolicy()).toEqual(beforePolicy);
  }, 30000);

  it('checks base-head CAS and allows archived or stale proposals only as explicit new copies', async () => {
    const { app, id, drafts } = await draftApp();
    const base = app.services.scripts.create({ name: 'Head', source: SMA_SOURCE, inputs: {}, props: {} });
    const draft = await drafts.propose(id, { name: 'Old head proposal', source: SMA_SOURCE, baseRevisionId: base.revision.id });
    app.services.scripts.update(base.script.id, { name: 'User edit', revision: 1, source: SMA_SOURCE.replace('input.int(2', 'input.int(3'), inputs: {}, props: {} });
    await expect(drafts.apply(draft.id, { revision: 1, mode: 'update', name: 'No overwrite' })).rejects.toMatchObject({ code: 'SCRIPT_HEAD_CONFLICT' });
    app.services.scripts.archive(base.script.id);
    await expect(drafts.apply(draft.id, { revision: 1, mode: 'update', name: 'No revival' })).rejects.toMatchObject({ code: 'SCRIPT_ARCHIVED' });
    const copied = await drafts.apply(draft.id, { revision: 1, mode: 'new', name: 'User copy' });
    expect(copied.script.id).not.toBe(base.script.id);
    expect(copied.revision.source).toBe(SMA_SOURCE);
    expect(app.services.scripts.get(base.script.id).script.archivedAt).not.toBeNull();
    expect(app.services.scripts.get(base.script.id).script.revision).toBe(2);
  }, 15000);

  it('publishes one immutable revision under concurrent repeated Apply and retains the original response after later edits', async () => {
    const { app, id, drafts } = await draftApp();
    const draft = await drafts.propose(id, { name: 'Proposal', source: SMA_SOURCE });
    const before = app.services.scripts.list().length;
    const command = { revision: draft.revision, mode: 'new' as const, name: 'Explicit original name' };
    const [first, repeat] = await Promise.all([drafts.apply(draft.id, command), drafts.apply(draft.id, command)]);
    expect(repeat).toEqual(first);
    expect(app.services.scripts.list().length).toBe(before + 1);
    expect(app.services.scripts.revisions(first.script.id).map(row => row.id)).toEqual([first.revision.id]);
    await expect(drafts.apply(draft.id, { ...command, name: 'Different command' })).rejects.toMatchObject({ code: 'DRAFT_ALREADY_APPLIED' });
    app.services.scripts.update(first.script.id, { revision: 1, name: 'Later user edit', source: SMA_SOURCE.replace('input.int(2', 'input.int(3'), inputs: {}, props: {} });
    expect(await drafts.apply(draft.id, command)).toEqual(first);
    expect(app.services.scripts.get(first.script.id).script.revision).toBe(2);
  }, 15000);

  it('rejects stale edits and prevents an in-flight validation from certifying subsequently changed content', async () => {
    const { app, id, drafts } = await draftApp();
    const draft = await drafts.propose(id, { name: 'Race', source: SMA_SOURCE });
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const actualValidate = app.services.pine.validate.bind(app.services.pine);
    vi.spyOn(app.services.pine, 'validate').mockImplementation(async (...args) => {
      const realResult = await actualValidate(...args); entered.resolve(); await resume.promise; return realResult;
    });
    const validating = drafts.validate(draft.id, draft.revision);
    await entered.promise;
    const edited = drafts.update(draft.id, { revision: 1, name: 'Changed during validation', source: '//@version=6\nindicator("Changed")\nplot(', inputs: {}, props: {} });
    expect(() => drafts.update(draft.id, { revision: 1, name: 'Stale overwrite', source: SMA_SOURCE, inputs: {}, props: {} })).toThrow(expect.objectContaining({ code: 'DRAFT_REVISION_CONFLICT' }));
    resume.resolve();
    await expect(validating).rejects.toMatchObject({ code: 'DRAFT_REVISION_CONFLICT' });
    expect(drafts.get(draft.id)).toMatchObject({ revision: edited.revision, source: edited.source, validation: null });
    await expect(drafts.apply(draft.id, { revision: edited.revision, mode: 'new', name: 'Unvalidated' })).rejects.toMatchObject({ code: 'DRAFT_VALIDATION_REQUIRED' });
  }, 20000);

  it('requires an admin session and CSRF and rejects model-provided mutation authority fields', async () => {
    const { app, id, drafts, headers } = await draftApp();
    const draft = await drafts.propose(id, { name: 'Auth boundary', source: SMA_SOURCE });
    expect((await app.inject({ url: `/api/v1/agent/drafts/${draft.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/v1/agent/drafts/${draft.id}/apply`, headers: { cookie: headers.cookie, origin: headers.origin }, payload: { revision: 1, mode: 'new', name: 'Forbidden' } })).statusCode).toBe(403);
    const extra = await app.inject({ method: 'PUT', url: `/api/v1/agent/drafts/${draft.id}`, headers, payload: { revision: 1, name: 'Malicious authority', source: SMA_SOURCE, inputs: {}, props: {}, scriptId: randomUUID(), baseRevisionId: randomUUID(), enablePolicy: true } });
    expect(extra.statusCode).toBe(400);
    expect(drafts.get(draft.id)).toEqual(draft);
    expect((await app.inject({ url: `/api/v1/agent/sessions/${id}/drafts`, headers })).json().drafts).toEqual([draft]);
  }, 15000);
});
