import { createHash, randomUUID } from 'node:crypto';
import type { CreateScript, ScriptRecord, ScriptRevision, UpdateScript } from '@pineterm/contracts';
import { PINE_TEMPLATES } from '../../../../packages/contracts/src/templates.js';
import { pineSourceVersion } from '../../../../packages/contracts/src/pine.js';
import type { AppDatabase } from '../database.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';

export const MAX_PINE_BYTES = 256 * 1024;
interface ScriptRow { id: string; name: string; revision: number; current_revision_id: string; archived_at: number | null; created_at: number; updated_at: number }
interface RevisionRow { id: string; script_id: string; revision: number; source: string; source_hash: string; language_version: 5 | 6; inputs_json: string; props_json: string; created_at: number }
const scriptSelect = 'SELECT s.*,r.id AS current_revision_id FROM scripts s JOIN script_revisions r ON r.script_id=s.id AND r.revision=s.revision';

function record(row: ScriptRow): ScriptRecord {
  return { id: row.id, name: row.name, revision: row.revision, currentRevisionId: row.current_revision_id, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function revision(row: RevisionRow): ScriptRevision {
  return { id: row.id, scriptId: row.script_id, revision: row.revision, source: row.source, sourceHash: row.source_hash, languageVersion: row.language_version, inputs: JSON.parse(row.inputs_json) as ScriptRevision['inputs'], props: JSON.parse(row.props_json) as ScriptRevision['props'], createdAt: row.created_at };
}
export function pineLanguageVersion(source: string): 5 | 6 {
  if (Buffer.byteLength(source, 'utf8') > MAX_PINE_BYTES) throw new ApiError(400, 'SOURCE_TOO_LARGE', 'Pine source is limited to 256 KiB of UTF-8.');
  // This is the Pine text entry-point gate, not a parser or a claim that the script compiles.
  const version = pineSourceVersion(source);
  if (version === null) throw new ApiError(422, 'PINE_VERSION_REQUIRED', 'Import Pine v5/v6 text with a //@version=5 or //@version=6 compiler annotation. JavaScript/function entry points are not supported.');
  return version;
}

/** Mutable names/head pointers; all execution references address immutable revision IDs. */
export class ScriptService {
  constructor(private readonly db: AppDatabase, private readonly clock: () => number, private readonly events: InvalidationHub) {
    db.transaction(() => {
      if (db.prepare<[], { count: number }>('SELECT count(*) AS count FROM scripts').get()!.count !== 0) return;
      for (const template of PINE_TEMPLATES) this.insert({ name: template.name, source: template.source, inputs: {}, props: {} });
    }).immediate();
  }
  list(): ScriptRecord[] { return this.db.prepare<[], ScriptRow>(`${scriptSelect} WHERE s.archived_at IS NULL ORDER BY s.updated_at DESC,s.id`).all().map(record); }
  get(id: string): { script: ScriptRecord; revision: ScriptRevision } {
    const row = this.db.prepare<[string], ScriptRow>(`${scriptSelect} WHERE s.id=?`).get(id);
    if (!row) throw new ApiError(404, 'SCRIPT_NOT_FOUND', 'The script does not exist.');
    return { script: record(row), revision: this.getRevision(row.current_revision_id) };
  }
  getRevision(id: string): ScriptRevision {
    const row = this.db.prepare<[string], RevisionRow>('SELECT * FROM script_revisions WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'SCRIPT_REVISION_NOT_FOUND', 'The immutable script revision does not exist.');
    return revision(row);
  }
  revisions(id: string): ScriptRevision[] {
    this.get(id);
    return this.db.prepare<[string], RevisionRow>('SELECT * FROM script_revisions WHERE script_id=? ORDER BY revision DESC').all(id).map(revision);
  }
  private insert(body: CreateScript): { script: ScriptRecord; revision: ScriptRevision } {
    const languageVersion = pineLanguageVersion(body.source);
    const name = body.name.trim();
    if (!name || name.length > 100) throw new ApiError(400, 'INVALID_NAME', 'Script name must contain 1–100 characters.');
    const id = randomUUID(); const revisionId = randomUUID(); const now = this.clock();
    this.db.prepare('INSERT INTO scripts(id,name,revision,created_at,updated_at) VALUES (?,?,1,?,?)').run(id, name, now, now);
    this.db.prepare('INSERT INTO script_revisions(id,script_id,revision,source,source_hash,language_version,inputs_json,props_json,created_at) VALUES (?,?,1,?,?,?,?,?,?)').run(revisionId, id, body.source, createHash('sha256').update(body.source, 'utf8').digest('hex'), languageVersion, JSON.stringify(body.inputs), JSON.stringify(body.props), now);
    return this.get(id);
  }
  create(body: CreateScript): { script: ScriptRecord; revision: ScriptRevision } {
    const { value, event } = this.db.transaction(() => {
      const value = this.insert(body);
      return { value, event: this.events.record('scripts.changed', value.script.id, value.script.revision) };
    }).immediate();
    this.events.emit(event); return value;
  }
  update(id: string, body: UpdateScript): { script: ScriptRecord; revision: ScriptRevision } {
    const languageVersion = pineLanguageVersion(body.source);
    const name = body.name.trim();
    if (!name || name.length > 100) throw new ApiError(400, 'INVALID_NAME', 'Script name must contain 1–100 characters.');
    const { value, event } = this.db.transaction(() => {
      const current = this.get(id).script;
      if (current.archivedAt !== null) throw new ApiError(409, 'SCRIPT_ARCHIVED', 'The script is archived. Save a new copy instead.');
      if (current.revision !== body.revision) throw new ApiError(409, 'REVISION_CONFLICT', 'A newer script revision exists. Reload it or save your draft as a copy.', { currentRevision: current.revision });
      const now = this.clock(); const number = current.revision + 1;
      const changed = this.db.prepare('UPDATE scripts SET name=?,revision=?,updated_at=? WHERE id=? AND revision=? AND archived_at IS NULL').run(name, number, now, id, body.revision);
      if (changed.changes !== 1) throw new ApiError(409, 'REVISION_CONFLICT', 'The script changed before this save.');
      this.db.prepare('INSERT INTO script_revisions(id,script_id,revision,source,source_hash,language_version,inputs_json,props_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, number, body.source, createHash('sha256').update(body.source, 'utf8').digest('hex'), languageVersion, JSON.stringify(body.inputs), JSON.stringify(body.props), now);
      return { value: this.get(id), event: this.events.record('scripts.changed', id, number) };
    }).immediate();
    this.events.emit(event); return value;
  }
  archive(id: string): void {
    const event = this.db.transaction(() => {
      const current = this.get(id).script;
      if (current.archivedAt !== null) return null;
      const now = this.clock();
      this.db.prepare('UPDATE scripts SET archived_at=?,updated_at=? WHERE id=?').run(now, now, id);
      return this.events.record('scripts.changed', id, current.revision);
    }).immediate();
    if (event) this.events.emit(event);
  }
}
