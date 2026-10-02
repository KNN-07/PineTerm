import type { MarketRef } from './market.js';
import type { PineDiagnostic, PineValidation, PineValue, ScriptRecord, ScriptRevision } from './pine.js';

export const AGENT_TOOL_NAMES = ['get_market_bars', 'get_quote', 'get_indicator_values', 'get_portfolio', 'get_script', 'validate_pine', 'run_backtest', 'propose_script'] as const;
export type AnalysisToolName = typeof AGENT_TOOL_NAMES[number];
export interface AgentConfig {
  configured: boolean; revision: number; provider: string | null; model: string | null; baseUrl: string | null;
  authMode: 'api-key' | 'none'; apiKeyConfigured: boolean; contextWindow: number | null; maxTokens: number | null;
}
export interface UpdateAgentConfig {
  revision: number; provider: string; model: string; apiKey?: string; baseUrl?: string | null;
  authMode: 'api-key' | 'none'; contextWindow?: number; maxTokens?: number;
}
export interface AgentModelChoice { provider: string; id: string; name: string; contextWindow: number; maxTokens: number }
export interface AgentStatus { configured: boolean; available: boolean; reason: string | null; provider: string | null; model: string | null; tools: AnalysisToolName[]; authority: 'analysis-and-drafts' }
export interface AgentContext { market: MarketRef; timeframe: string; scriptRevisionId?: string; paperAccountId?: string; replaySessionId?: string }
export interface AgentMessageRequest { text: string; context: AgentContext }
export interface AgentUsage { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null; costUsd: number | null }
export interface AgentToolProvenance { tool: AnalysisToolName; market?: MarketRef; timeframe?: string; from?: number; to?: number; asOf?: number; status?: string; scriptRevisionId?: string; paperAccountId?: string; jobId?: string; draftId?: string }
export interface AgentMessage { id: string; role: 'user' | 'assistant' | 'tool'; text: string; createdAt: number; tool?: AnalysisToolName; provenance?: AgentToolProvenance; usage?: AgentUsage; error?: boolean }
export interface AgentSessionRecord { id: string; title: string; provider: string; model: string; state: 'idle' | 'running'; createdAt: number; updatedAt: number }
export interface AgentSessionView extends AgentSessionRecord { messages: AgentMessage[]; drafts: AgentDraft[] }
export type AgentEvent =
  | { id: number; type: 'text_delta'; sessionId: string; turnId: string; text: string }
  | { id: number; type: 'tool_start' | 'tool_progress' | 'tool_end'; sessionId: string; turnId: string; tool: AnalysisToolName; text: string; provenance?: AgentToolProvenance }
  | { id: number; type: 'draft'; sessionId: string; turnId: string; draftId: string }
  | { id: number; type: 'error'; sessionId: string; turnId: string; code: string; message: string }
  | { id: number; type: 'settled'; sessionId: string; turnId: string; state: 'completed' | 'cancelled' | 'failed'; usage?: AgentUsage };
export interface ProposeAgentDraft { name: string; source: string; baseRevisionId?: string; inputs?: Record<string, PineValue>; props?: Record<string, PineValue> }
export interface AgentDraft {
  id: string; sessionId: string; name: string; revision: number; source: string; baseSource: string | null;
  scriptId: string | null; baseRevisionId: string | null; inputs: Record<string, PineValue>; props: Record<string, PineValue>;
  validation: PineValidation | null; diagnostics: PineDiagnostic[]; appliedRevisionId: string | null; createdAt: number; updatedAt: number;
}
export interface UpdateAgentDraft { revision: number; name: string; source: string; inputs: Record<string, PineValue>; props: Record<string, PineValue> }
export interface ApplyAgentDraft { revision: number; mode: 'new' | 'update'; name: string }
export interface AppliedAgentDraft { draft: AgentDraft; script: ScriptRecord; revision: ScriptRevision }
