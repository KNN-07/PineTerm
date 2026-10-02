import type { Bar, Instrument, MarketRef } from './market.js';

export interface PaperAccount { id: string; name: string; mode: 'live' | 'replay'; quoteCurrency: string; initialBalance: string; cashBalance: string; reservedCash: string; availableCash: string; commissionBps: string; slippageBps: string; revision: number; archivedAt: number | null; createdAt: number; updatedAt: number }
export interface CreatePaperAccount { name: string; quoteCurrency: string; initialBalance?: string; commissionBps?: string; slippageBps?: string }
export interface PaperOrderRequest { accountId: string; market: MarketRef; side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop'; quantity: string; limitPrice?: string; stopPrice?: string }
export interface PaperOrder extends PaperOrderRequest { id: string; acceptedSequence: number; reservedCash: string; reservedQuantity: string; state: 'open' | 'filled' | 'cancelled' | 'rejected'; waitingReason: string | null; acceptedAt: number; completedAt: number | null }
export interface PaperPosition { id: string; accountId: string; market: MarketRef; quantity: string; reservedQuantity: string; availableQuantity: string; costBasis: string; averageCost: string | null; realizedPnl: string; unrealizedPnl: string | null; marketValue: string | null; quoteObservedAt: number | null; quoteStatus: 'live' | 'stale' | 'historical' | 'unavailable'; revision: number }
export interface PaperFill { id: string; orderId: string; accountId: string; market: MarketRef; side: 'buy' | 'sell'; quantity: string; price: string; fee: string; currency: string; sourceEventId: string; occurredAt: number; createdAt: number }
export interface PaperLedgerEntry { id: string; accountId: string; fillId: string | null; kind: 'initial_balance' | 'fill' | 'reset'; cashDelta: string; cashBalance: string; details: Record<string, unknown>; occurredAt: number }
export interface PaperAccountView { account: PaperAccount; positions: PaperPosition[]; orders: PaperOrder[]; fills: PaperFill[]; ledger: PaperLedgerEntry[] }
export interface ReplayMarket { market: MarketRef; timeframe: string }
export interface ReplayRequest { markets: ReplayMarket[]; from: number; to: number; quoteCurrency: string; initialBalance?: string; commissionBps?: string; slippageBps?: string }
export interface ReplaySession { id: string; accountId: string; state: 'active' | 'stopped'; markets: ReplayMarket[]; baseTimeframe: string; from: number; to: number; cursor: number; revision: number; createdAt: number; updatedAt: number }
export interface ReplaySnapshot { market: MarketRef; timeframe: string; bars: Bar[]; symbolInfo: Instrument }
