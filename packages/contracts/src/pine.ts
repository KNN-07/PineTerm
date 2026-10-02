import type { Bar, Instrument, MarketRef } from './market.js';

export type PineValue = string | number | boolean;
export const PINE_TS_PROVIDER_POLICY = 'Provider-locked secondary data: request.security and request.security_lower_tf resolve only in the selected run venue. PineTS 0.10.0 discards dynamically computed exchange prefixes before the provider seam; computed prefixes do not select a venue. No cross-venue data is fetched.';

/** The first compiler annotation selects the language, including comment/license preludes. */
export function pineSourceVersion(source: string): 5 | 6 | null {
  const version = Number(/^[ \t\uFEFF]*\/\/@version[ \t]*=[ \t]*(\d+)\b/m.exec(source)?.[1]);
  return version === 5 || version === 6 ? version : null;
}
export interface PineDiagnostic { code: string; message: string; line?: number; column?: number }
export interface PineInputMeta { id: string; name: string; varId?: string; title?: string; type: string; defval: unknown; minval?: number; maxval?: number; step?: number; options?: unknown[]; tooltip?: string; group?: string; inline?: string; active?: boolean; display?: string; confirm?: boolean }
export interface PinePropMeta { name: string; type: string; defval: unknown; mutable: boolean; appliesTo: string; options?: unknown[]; minval?: number; maxval?: number; version?: number }
export interface PineValidation { valid: boolean; declarationType: 'indicator' | 'strategy' | null; inputs: PineInputMeta[]; props: PinePropMeta[]; diagnostics: PineDiagnostic[]; warnings?: Array<{ message: string; bar?: number; method?: string }> }
export interface ScriptRecord { id: string; name: string; revision: number; currentRevisionId: string; archivedAt: number | null; createdAt: number; updatedAt: number }
export interface ScriptRevision { id: string; scriptId: string; revision: number; source: string; sourceHash: string; languageVersion: 5 | 6; inputs: Record<string, PineValue>; props: Record<string, PineValue>; createdAt: number }
export interface CreateScript { name: string; source: string; inputs: Record<string, PineValue>; props: Record<string, PineValue> }
export interface UpdateScript extends CreateScript { revision: number }
export interface BacktestRequest { scriptRevisionId: string; market: MarketRef; timeframe: string; from: number; to: number; inputs: Record<string, PineValue>; props: Record<string, PineValue> }
export interface EquityPoint { time: number; equity: string | null; drawdown: string | null }
export interface StrategyTrade { id: string; entryId: string; exitId: string | null; side: 'long' | 'short'; quantity: string; entryPrice: string; exitPrice: string | null; entryTime: number; exitTime: number | null; entryBarIndex: number; exitBarIndex: number | null; profit: string | null; commission: string | null; status: 'open' | 'closed' }
export interface StrategySummary { currency: string; initialEquity: string | null; finalEquity: string | null; netPnl: string | null; fees: string | null; maxDrawdown: string | null; winRate: number | null; tradeCount: number; profitFactor: number | null; positionSize: string }
export interface PineExecutionResult extends PineValidation { engineVersion: '0.10.0'; strategy: StrategySummary | null; resolvedConfig: Record<string, unknown>; equityCurve: EquityPoint[]; trades: StrategyTrade[]; plots: Record<string, { data: Array<{ time: number; value: unknown; [key: string]: unknown }>; [key: string]: unknown }>; alerts: Array<{ type: string; id: string; message: string; title?: string; freq?: string; bar_index: number; time: number }>; warnings: Array<{ message: string; bar?: number; method?: string }>; logs: string[] }
export interface BacktestJob { id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; request: BacktestRequest; createdAt: number; startedAt: number | null; completedAt: number | null; diagnostic: PineDiagnostic | null; result: PineExecutionResult | null; provenance: Record<string, unknown> | null }
export interface PineRunRequest { type: 'run'; jobId: string; source: string; inputs: Record<string, PineValue>; props: Record<string, PineValue>; market: MarketRef; timeframe: string; from: number; to: number; bars: Bar[]; symbolInfo: Instrument; alertMode?: 'all' | 'realtime' }
export interface PineValidateRequest { type: 'validate'; jobId: string; source: string; inputs: Record<string, PineValue>; props: Record<string, PineValue> }
export interface PineDataRequest { type: 'data_request'; id: string; market: MarketRef; timeframe: string; from: number; to: number; limit: number }
export interface PineDataResponse { type: 'data_response'; id: string; bars?: Bar[]; symbolInfo?: Instrument; error?: PineDiagnostic }
