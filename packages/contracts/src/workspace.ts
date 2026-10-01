import type { MarketRef } from './market.js';

export interface Workspace { id: string; name: string; revision: number; velaState: Record<string, unknown>; uiState: Record<string, unknown>; createdAt: number; updatedAt: number }
export interface CreateWorkspace { name: string; velaState: Record<string, unknown>; uiState: Record<string, unknown> }
export interface UpdateWorkspace extends CreateWorkspace { revision: number }
export interface Watchlist { id: string; name: string; revision: number; items: MarketRef[]; createdAt: number; updatedAt: number }
export interface CreateWatchlist { name: string; items: MarketRef[] }
export interface UpdateWatchlist extends CreateWatchlist { revision: number }
