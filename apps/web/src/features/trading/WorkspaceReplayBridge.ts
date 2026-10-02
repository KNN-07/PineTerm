import type { Bar, MarketRef, ReplaySession } from '@pineterm/contracts';

export interface ReplayChartTape { id: string; market: MarketRef; timeframe: string; bars: Bar[] }
/** Host-owned boundary: public Vela APIs only; no worker or chart internals escape. */
export interface WorkspaceReplayBridge {
  bind(session: ReplaySession | null): void;
  loadTapes(tapes: ReplayChartTape[]): Promise<void>;
  resetEngines(): void;
  reloadLive(): Promise<void>;
}
