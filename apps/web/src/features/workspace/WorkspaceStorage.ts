import { DrawingStore, NativeRenderer } from '@luxalgo/vela';
import { ensureLayout, registerBuiltinLayouts, sanitizeState } from '@luxalgo/vela/workspace';
import type { WorkspaceState, VelaWorkspaceOptions } from '@luxalgo/vela/workspace';
import type { Workspace } from '@pineterm/contracts';
import { ApiClient, ApiError, errorMessage } from '../../api.js';

registerBuiltinLayouts();

export const DEFAULT_VELA_STATE: WorkspaceState = {
  version: 1, layout: '1', activeCellId: 'c1', sync: { crosshair: true }, timezone: 'Etc/UTC',
  charts: [{ id: 'c1', symbol: 'COINBASE:BTC-USD', timeframe: '60', priceStyle: 'candles' }],
};
export type SaveStatus = 'Saved' | 'Unsaved' | 'Saving' | 'Failed' | 'Conflict' | 'Invalid';
export interface StorageSnapshot { status: SaveStatus; message: string | null; workspace: Workspace; uiState: Record<string, unknown>; recovered: boolean }
interface Draft { revision: number; velaState: Record<string, unknown>; uiState: Record<string, unknown>; name: string }

// Compare every supplied field against the public codecs' result. Vela deliberately
// drops malformed fields; a durable PineTerm document must never lose them silently.
function retained(input: unknown, output: unknown): boolean {
  if (Array.isArray(input)) return Array.isArray(output) && input.length === output.length && input.every((item, index) => retained(item, output[index]));
  if (input && typeof input === 'object') return !!output && typeof output === 'object' && !Array.isArray(output)
    && Object.entries(input).every(([key, value]) => {
      if (Object.hasOwn(output, key)) return retained(value, (output as Record<string, unknown>)[key]);
      if (value === false && ['crosshair', 'symbol', 'timeframe', 'viewport', 'drawings', 'style'].includes(key)) return true;
      if (Array.isArray(value) && value.length === 0 && ['favorites', 'timeframeFavorites', 'pinned'].includes(key)) return true;
      return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 && ['sync', 'ext', 'trackSizes', 'panels', 'widths'].includes(key);
    });
  return Object.is(input, output);
}

export function validateVelaState(value: unknown): WorkspaceState {
  const state = sanitizeState(value);
  const visibleCount = state ? ensureLayout(state.layout)?.cells.length : undefined;
  if (!state || !retained(value, state) || !visibleCount || state.charts.length < visibleCount) {
    throw new Error('Stored chart state is invalid or uses an unsupported layout/version. The original document has been preserved.');
  }
  if (state.activeCellId && !state.charts.slice(0, visibleCount).some((chart) => chart.id === state.activeCellId)) throw new Error('Stored active chart is not in the visible layout.');
  if (state.timezone && state.timezone !== 'exchange') {
    try { new Intl.DateTimeFormat('en', { timeZone: state.timezone }); }
    catch { throw new Error('Stored chart timezone is invalid.'); }
  }
  // Public config methods work before mount; destroy requires a mounted backend.
  // This unmounted codec probe owns no DOM, timers, subscriptions or GPU resources.
  const renderer = state.charts.some((chart) => chart.rendererConfig !== undefined) ? new NativeRenderer() : null;
  for (const chart of state.charts) {
    if (chart.symbol && !/^(BINANCE|COINBASE|CSV):.+$/i.test(chart.symbol)) throw new Error('Stored chart has no supported provider-qualified symbol.');
    if (chart.priceStyle && !['candles', 'bars', 'line', 'area', 'baseline', 'heikinashi'].includes(chart.priceStyle)) throw new Error('Stored chart style is unavailable.');
    if (chart.drawings !== undefined) {
      const store = new DrawingStore();
      store.load(chart.drawings);
      if (!retained(chart.drawings, store.serialize())) throw new Error('Stored drawing state contains invalid or unavailable objects.');
    }
    if (chart.rendererConfig !== undefined && renderer) {
      renderer.applyConfig(chart.rendererConfig);
      if (!retained(chart.rendererConfig, renderer.getConfig())) throw new Error('Stored chart settings contain invalid or unavailable fields.');
    }
  }
  return state;
}

/** Vela's exact get/set storage contract; server writes are serialized revision CAS. */
export class WorkspaceStorage implements NonNullable<VelaWorkspaceOptions['storage']> {
  readonly key: string;
  private raw: string;
  private ui: Record<string, unknown>;
  private record: Workspace;
  private baseRevision: number;
  private invalidDraft: string | null = null;
  private generation = 0;
  private savedGeneration = 0;
  private timer: number | undefined;
  private running: Promise<void> | null = null;
  private stopped = false;
  private blocked = false;
  private recovered = false;
  private status: SaveStatus = 'Saved';
  private message: string | null = null;
  private listeners = new Set<(snapshot: StorageSnapshot) => void>();

  constructor(private readonly client: ApiClient, record: Workspace, private readonly onSessionError: (error: ApiError) => void) {
    this.record = record;
    this.baseRevision = record.revision;
    this.key = `pineterm.workspace.${record.id}`;
    this.raw = JSON.stringify(record.velaState);
    this.ui = record.uiState;
    let draftRaw: string | null = null;
    try { draftRaw = localStorage.getItem(`${this.key}.draft`); }
    catch { this.message = 'Local draft storage is unavailable. Download changes before leaving this tab.'; }
    try {
      if (draftRaw) {
        const draft = JSON.parse(draftRaw) as Draft;
        if (!draft || typeof draft.revision !== 'number' || typeof draft.name !== 'string' || !draft.uiState || typeof draft.uiState !== 'object' || !draft.velaState || typeof draft.velaState !== 'object') throw new Error('Local workspace draft is unreadable; download it before resetting it.');
        this.raw = JSON.stringify(draft.velaState);
        this.ui = draft.uiState;
        this.record = { ...record, name: draft.name };
        this.baseRevision = draft.revision;
        this.generation = 1;
        this.recovered = true;
        this.status = draft.revision === record.revision ? 'Unsaved' : 'Conflict';
        this.blocked = draft.revision !== record.revision;
        this.message = this.blocked ? 'The server changed while this local draft was unsaved. Reload or save the draft as a copy.' : 'Recovered an unsaved local draft. Flush to save it to the server.';
      }
      validateVelaState(JSON.parse(this.raw));
    } catch (error) {
      this.invalidDraft = draftRaw;
      this.status = 'Invalid'; this.blocked = true; this.message = errorMessage(error);
    }
  }

  snapshot(): StorageSnapshot { return { status: this.status, message: this.message, workspace: this.record, uiState: this.ui, recovered: this.recovered }; }
  subscribe(listener: (snapshot: StorageSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot());
    this.stopped = false;
    return () => { this.listeners.delete(listener); };
  }
  private emit(): void { for (const listener of this.listeners) listener(this.snapshot()); }
  get(key: string): string | null { return key === this.key && this.status !== 'Invalid' ? this.raw : null; }
  set(key: string, value: string): void {
    if (this.stopped || key !== this.key || this.status === 'Invalid' || value === this.raw) return;
    this.raw = value; this.changed();
  }
  updateUi(uiState: Record<string, unknown>): void {
    if (this.stopped || this.status === 'Invalid' || JSON.stringify(uiState) === JSON.stringify(this.ui)) return;
    this.ui = uiState; this.changed();
  }
  rename(name: string): void { this.record = { ...this.record, name }; this.changed(); }
  private changed(): void {
    this.generation++;
    if (!this.blocked) { this.status = 'Unsaved'; this.message = null; }
    this.persistDraft(); this.emit();
    window.clearTimeout(this.timer);
    if (!this.blocked) this.timer = window.setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, 900);
  }
  private persistDraft(): void {
    try {
      localStorage.setItem(`${this.key}.draft`, JSON.stringify({ revision: this.baseRevision, name: this.record.name, velaState: JSON.parse(this.raw), uiState: this.ui } satisfies Draft));
    } catch {
      this.message = 'Local draft storage is unavailable or full. Keep this tab open and download the draft before leaving.';
    }
  }
  flush(): Promise<void> {
    window.clearTimeout(this.timer); this.timer = undefined;
    if (this.running) return this.running;
    if (this.blocked) return Promise.reject(new Error(this.message ?? 'Resolve the saved-state error before saving.'));
    if (this.generation === this.savedGeneration || this.stopped) return Promise.resolve();
    const task = Promise.withResolvers<void>();
    this.running = task.promise;
    void (async () => {
      try {
        while (!this.stopped && this.generation !== this.savedGeneration) {
          this.status = 'Saving'; this.message = null; this.emit();
          const generation = this.generation;
          const velaState = JSON.parse(this.raw) as Record<string, unknown>;
          const { workspace } = await this.client.request<{ workspace: Workspace }>(`/workspaces/${this.record.id}`, {
            method: 'PUT', csrf: true, body: { name: this.record.name, revision: this.record.revision, velaState, uiState: this.ui },
          });
          this.record = { ...workspace, name: this.record.name };
          this.baseRevision = workspace.revision;
          this.savedGeneration = generation;
          if (generation === this.generation) {
            this.recovered = false;
            try { localStorage.removeItem(`${this.key}.draft`); } catch { /* The server copy is durable. */ }
          } else this.persistDraft();
        }
        this.status = 'Saved'; this.message = null; this.emit(); task.resolve();
      } catch (error) {
        this.blocked = error instanceof ApiError && error.status === 409;
        this.status = this.blocked ? 'Conflict' : 'Failed'; this.message = errorMessage(error);
        this.persistDraft(); this.emit(); task.reject(error);
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) this.onSessionError(error);
      } finally { this.running = null; }
    })();
    return task.promise;
  }
  async saveAsCopy(name: string): Promise<Workspace> {
    const velaState = JSON.parse(this.raw) as Record<string, unknown>;
    const { workspace } = await this.client.request<{ workspace: Workspace }>('/workspaces', { method: 'POST', csrf: true, body: { name, velaState, uiState: this.ui } });
    return workspace;
  }
  original(): Blob { return new Blob([this.invalidDraft ?? JSON.stringify({ ...this.record, velaState: JSON.parse(this.raw), uiState: this.ui }, null, 2)], { type: 'application/json' }); }
  discardLocalDraft(): void { this.stopped = true; window.clearTimeout(this.timer); localStorage.removeItem(`${this.key}.draft`); }
  dispose(): void { this.stopped = true; window.clearTimeout(this.timer); this.listeners.clear(); }
}
