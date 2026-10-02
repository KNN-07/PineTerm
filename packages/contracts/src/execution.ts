import type { MarketRef } from './market.js';
import { marketRefSchema } from './market.js';

export interface ExecutorRecord { id: string; name: string; enabled: boolean; claimsPausedReason: string | null; revision: number; createdAt: number; updatedAt: number; archivedAt: number | null }
export interface ExecutorCommand { name: string; enabled: boolean }
export interface UpdateExecutor extends ExecutorCommand { revision: number }
export interface ExecutionMarketRule { market: MarketRef; sides: Array<'buy' | 'sell'> }
export interface ExecutionCurrencyLimit { quoteCurrency: string; perOrderNotional: string; rolling24hNotional: string }
export interface EnabledExecutionPolicy { enabled: true; allowlist: ExecutionMarketRule[]; quoteLimits: ExecutionCurrencyLimit[]; maxPending: number; maxDeviationBps: string }
export type ExecutionPolicyCommand = { enabled: false } | EnabledExecutionPolicy;
export type UpdateExecutionPolicy = ExecutionPolicyCommand & { revision: number };
export interface ExecutionPolicy { revision: number; enabled: boolean; allowlist: ExecutionMarketRule[]; quoteLimits: ExecutionCurrencyLimit[]; maxPending: number | null; maxDeviationBps: string | null; updatedAt: number | null }
export interface LiveAction { executorId: string; market: MarketRef; side: 'buy' | 'sell'; type: 'market' | 'limit'; quantity: string; limitPrice?: string }
export interface OrderIntentRequest extends LiveAction { expiresAt: number }
export type IntentState = 'pending' | 'claimed' | 'acknowledged' | 'partially_filled' | 'filled' | 'rejected' | 'cancelled' | 'expired' | 'unknown';
export interface ExternalFill { externalFillId: string; quantity: string; price: string; fee: string; currency: string; time: number }
export type ReportStatus = 'acknowledged' | 'partially_filled' | 'filled' | 'rejected' | 'cancelled' | 'expired' | 'unknown';
export interface ExecutorReport { reportId: string; status: ReportStatus; externalOrderId?: string; fills: ExternalFill[] }
export interface SubmitExecutorReport extends ExecutorReport { leaseToken: string }
export interface RecordedExecutorReport extends ExecutorReport { id: string; intentId: string; executorId: string; createdAt: number }
export interface IntentRisk { requestedNotional: string; retainedNotional: string; pendingCapacity: boolean; resolvedAt: number | null }
export interface LiveIntent extends OrderIntentRequest {
  id: string; quoteCurrency: string; referencePrice: string; referenceObservedAt: number; maximumDeviationBps: string;
  minExecutionPrice: string | null; maxExecutionPrice: string | null; state: IntentState; cancelRequested: boolean;
  leaseExpiresAt: number | null; externalOrderId: string | null; revision: number; createdAt: number; updatedAt: number;
  sourceEventId: string | null; filledQuantity: string; risk: IntentRisk; reports: RecordedExecutorReport[];
}
/** Only an executor-bound key can read the lease token; ordinary intent/administrator views never include it. */
export interface ExecutorLease {
  intent: LiveIntent; clientOrderId: string; leaseToken: string; leaseExpiresAt: number;
  quoteCurrency: string; quantityStep: string; tickSize: string; minExecutionPrice: string | null; maxExecutionPrice: string | null;
}
export interface ExecutorClaim { claim: ExecutorLease | null; serverTime: number }
export interface ExecutorControl { executorId: string; executorEnabled: boolean; policyEnabled: boolean; claimsPausedReason: string | null; serverTime: number; orders: ExecutorLease[] }
export interface RiskUsage { quoteCurrency: string; rolling24hNotional: string; unresolvedNotional: string; pendingIntents: number }
/** Net externally reported fills only: not exchange balances or a complete portfolio. */
export interface ReportedPosition { executorId: string; market: MarketRef; quoteCurrency: string; netQuantity: string; boughtQuantity: string; soldQuantity: string; boughtNotional: string; soldNotional: string; fees: Record<string, string>; lastFillAt: number }
export interface ExecutionAudit { id: string; intentId: string | null; executorId: string | null; type: string; details: Record<string, unknown>; createdAt: number }
export interface LiveActionResult { state: 'pending' | 'created' | 'failed'; intentId: string | null; error: { code: string; message: string } | null }
export type DriverCommand = 'submit' | 'status' | 'cancel';
export interface DriverRequest {
  protocol: 1; command: DriverCommand; stage: 'preflight' | 'submit' | 'reconcile' | 'cancel'; clientOrderId: string;
  intent: Omit<LiveIntent, 'reports'>; quoteCurrency: string; quantityStep: string; tickSize: string;
  minExecutionPrice: string | null; maxExecutionPrice: string | null; now: number;
  requireSandbox?: boolean;
}
export interface DriverReply {
  status: 'not_submitted' | ReportStatus; externalOrderId?: string; fills: ExternalFill[];
  quote?: { market: MarketRef; price: string; observedAt: number }; reason?: string;
  absenceConfirmed?: boolean;
  environment?: 'live' | 'sandbox' | 'testnet' | 'recording'; venue?: string;
}

/** Fixed administrator-selected action, shared by intent and durable-alert command validation. */
export const liveActionSchema = {
  type: 'object', additionalProperties: false, required: ['executorId', 'market', 'side', 'type', 'quantity'],
  properties: {
    executorId: { type: 'string', format: 'uuid' }, market: marketRefSchema,
    side: { type: 'string', enum: ['buy', 'sell'] }, type: { type: 'string', enum: ['market', 'limit'] },
    quantity: { type: 'string', $ref: 'DecimalString#', maxLength: 100 },
    limitPrice: { type: 'string', $ref: 'DecimalString#', maxLength: 100 },
  },
} as const;
export const liveActionResultSchema = {
  type: 'object', additionalProperties: false, required: ['state', 'intentId', 'error'],
  properties: {
    state: { type: 'string', enum: ['pending', 'created', 'failed'] },
    intentId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
    error: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } }] },
  },
} as const;
