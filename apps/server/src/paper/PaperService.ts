import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Bar, CreatePaperAccount, Instrument, InvalidationEvent, MarketRef, PaperAccount, PaperAccountView, PaperFill, PaperLedgerEntry, PaperOrder, PaperOrderRequest, PaperPosition, Quote, ReplayMarket, ReplaySnapshot } from '@pineterm/contracts';
import { decimalString, financialDecimal } from '@pineterm/domain';
import { nextBucket, fixedDuration } from '../../../../packages/domain/src/market.js';
import { paperBuyReservation, paperExecutionPrice, paperFee, paperQuotePrice, paperReplayPrice, paperSpotFill, paperStepAligned } from '../../../../packages/domain/src/paper.js';
import type { AppDatabase } from '../database.js';
import type { InvalidationHub } from '../events.js';
import { ApiError } from '../errors.js';
import type { MarketService } from '../market/MarketService.js';

interface AccountRow { id: string; name: string; mode: 'live' | 'replay'; quote_currency: string; initial_balance: string; cash_balance: string; reserved_cash: string; commission_bps: string; slippage_bps: string; revision: number; archived_at: number | null; created_at: number; updated_at: number }
interface OrderRow { id: string; account_id: string; accepted_sequence: number; idempotency_key: string; request_hash: string; provider: MarketRef['provider']; symbol: string; side: PaperOrder['side']; type: PaperOrder['type']; quantity: string; limit_price: string | null; stop_price: string | null; reserved_cash: string; reserved_quantity: string; state: PaperOrder['state']; waiting_reason: string | null; accepted_at: number; completed_at: number | null; accepted_reference_event_id: string | null; accepted_reference_observed_at: number | null }
interface PositionRow { id: string; account_id: string; provider: MarketRef['provider']; symbol: string; quantity: string; reserved_quantity: string; cost_basis: string; realized_pnl: string; revision: number }
interface FillRow { id: string; order_id: string; account_id: string; provider: MarketRef['provider']; symbol: string; side: PaperFill['side']; quantity: string; price: string; fee: string; currency: string; source_event_id: string; occurred_at: number; created_at: number }
interface LedgerRow { id: string; account_id: string; fill_id: string | null; kind: PaperLedgerEntry['kind']; cash_delta: string; cash_balance: string; details_json: string; occurred_at: number }
interface ReplayRow { id: string; state: 'active' | 'stopped'; base_timeframe: string; cursor_time: number; to_time: number; markets_json: string }
interface ReplayContext { session: ReplayRow; series: ReplaySnapshot; quote: Quote | null }
interface Watermark { source_event_id: string; observed_at: number }

function accountDto(row: AccountRow): PaperAccount {
  return { id: row.id, name: row.name, mode: row.mode, quoteCurrency: row.quote_currency, initialBalance: row.initial_balance, cashBalance: row.cash_balance, reservedCash: row.reserved_cash, availableCash: decimalString(financialDecimal(row.cash_balance).minus(row.reserved_cash)), commissionBps: row.commission_bps, slippageBps: row.slippage_bps, revision: row.revision, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function orderDto(row: OrderRow): PaperOrder {
  return { id: row.id, accountId: row.account_id, market: { provider: row.provider, symbol: row.symbol }, side: row.side, type: row.type, quantity: row.quantity, ...(row.limit_price === null ? {} : { limitPrice: row.limit_price }), ...(row.stop_price === null ? {} : { stopPrice: row.stop_price }), acceptedSequence: row.accepted_sequence, reservedCash: row.reserved_cash, reservedQuantity: row.reserved_quantity, state: row.state, waitingReason: row.waiting_reason, acceptedAt: row.accepted_at, completedAt: row.completed_at };
}
/** Quotes have no upstream ID contract. Identity excludes status so warmup/reconnect cannot replay an observation. */
export function paperQuoteEventId(quote: Quote): string {
  return createHash('sha256').update(JSON.stringify([quote.market.provider, quote.market.symbol, quote.observedAt, quote.price])).digest('hex');
}
function checkedDecimal(value: string, label: string, positive: boolean): Decimal {
  let amount: Decimal;
  try { amount = financialDecimal(value); } catch { throw new ApiError(400, 'INVALID_DECIMAL', `${label} must be a canonical decimal string.`); }
  if (positive ? !amount.isPositive() : amount.isNegative()) throw new ApiError(400, 'INVALID_DECIMAL', `${label} must be ${positive ? 'positive' : 'nonnegative'}.`);
  return amount;
}

/** All cash, quantity, order and event mutations commit together; browser quotes never enter this API. */
export class PaperService {
  private readonly subscriptions = new Map<string, (() => void) | null>();
  private readonly quotes = new Map<string, Quote>();
  private readonly feedStatus = new Map<string, 'live' | 'stale'>();
  private closed = false;

  constructor(private readonly db: AppDatabase, private readonly market: MarketService, private readonly clock: () => number, private readonly events: InvalidationHub) {}

  async initialise(): Promise<void> { this.syncSubscriptions(); }
  async close(): Promise<void> {
    this.closed = true;
    for (const release of this.subscriptions.values()) release?.();
    this.subscriptions.clear(); this.quotes.clear(); this.feedStatus.clear();
  }

  private accountRow(id: string, active = false): AccountRow {
    const row = this.db.prepare<[string], AccountRow>('SELECT * FROM paper_accounts WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'PAPER_ACCOUNT_NOT_FOUND', 'The paper account does not exist.');
    if (active && row.archived_at !== null) throw new ApiError(409, 'PAPER_ACCOUNT_ARCHIVED', 'This account is archived. Use its fresh replacement account.');
    return row;
  }
  private orderRow(id: string): OrderRow {
    const row = this.db.prepare<[string], OrderRow>('SELECT * FROM paper_orders WHERE id=?').get(id);
    if (!row) throw new ApiError(404, 'PAPER_ORDER_NOT_FOUND', 'The paper order does not exist.');
    return row;
  }
  private publish(events: InvalidationEvent[]): void {
    if (!this.db.inTransaction) { for (const event of events) this.events.emit(event); return; }
    // Replay wraps paper mutations in its synchronous cursor transaction. A rolled-back row never emits.
    queueMicrotask(() => {
      if (this.closed || this.db.inTransaction) return;
      for (const event of events) if (this.db.prepare('SELECT 1 FROM invalidation_events WHERE id=?').get(event.id)) this.events.emit(event);
    });
  }
  private changed(id: string, now = this.clock()): InvalidationEvent {
    this.db.prepare('UPDATE paper_accounts SET revision=revision+1,updated_at=? WHERE id=?').run(now, id);
    return this.events.record('paper.changed', id, this.accountRow(id).revision);
  }

  private insertAccount(body: CreatePaperAccount, mode: 'live' | 'replay'): PaperAccountView {
    const name = body.name.trim();
    if (!name || name.length > 100) throw new ApiError(400, 'INVALID_NAME', 'Paper account name must contain 1–100 characters.');
    if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(body.quoteCurrency)) throw new ApiError(400, 'INVALID_CURRENCY', 'Use an exact uppercase quote currency code; USD and USDT are different currencies.');
    const balance = checkedDecimal(body.initialBalance ?? '10000', 'Initial balance', true);
    const commission = checkedDecimal(body.commissionBps ?? '10', 'Commission bps', false);
    const slippage = checkedDecimal(body.slippageBps ?? '0', 'Slippage bps', false);
    if (commission.gt(10000) || slippage.gte(10000)) throw new ApiError(400, 'INVALID_COSTS', 'Commission must be at most 10000 bps and slippage must be below 10000 bps.');
    const id = randomUUID(); const now = this.clock();
    this.db.prepare('INSERT INTO paper_accounts(id,name,mode,quote_currency,initial_balance,cash_balance,reserved_cash,commission_bps,slippage_bps,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,\'0\',?,?,1,?,?)').run(id, name, mode, body.quoteCurrency, decimalString(balance), decimalString(balance), decimalString(commission), decimalString(slippage), now, now);
    this.db.prepare('INSERT INTO paper_ledger(id,account_id,kind,cash_delta,cash_balance,details_json,occurred_at) VALUES (?,?,\'initial_balance\',?,?,?,?)').run(randomUUID(), id, decimalString(balance), decimalString(balance), JSON.stringify({ currency: body.quoteCurrency, mode }), now);
    return { account: accountDto(this.accountRow(id)), positions: [], orders: [], fills: [], ledger: this.ledger(id) };
  }
  createAccount(body: CreatePaperAccount): PaperAccountView {
    const { view, event } = this.db.transaction(() => { const view = this.insertAccount(body, 'live'); return { view, event: this.events.record('paper.changed', view.account.id, view.account.revision) }; }).immediate();
    this.publish([event]); return view;
  }
  createReplayAccount(body: CreatePaperAccount): PaperAccountView {
    const { view, event } = this.db.transaction(() => { const view = this.insertAccount(body, 'replay'); return { view, event: this.events.record('paper.changed', view.account.id, view.account.revision) }; }).immediate();
    this.publish([event]); return view;
  }
  listAccounts(mode?: 'live' | 'replay'): PaperAccount[] {
    return (mode === undefined ? this.db.prepare<[], AccountRow>('SELECT * FROM paper_accounts ORDER BY created_at DESC,id').all() : this.db.prepare<[string], AccountRow>('SELECT * FROM paper_accounts WHERE mode=? ORDER BY created_at DESC,id').all(mode)).map(accountDto);
  }
  async getAccount(id: string): Promise<PaperAccountView> {
    this.accountRow(id);
    await this.refreshMarks(id);
    // No awaits inside the account/holdings/history snapshot.
    return this.db.transaction(() => ({ account: accountDto(this.accountRow(id)), positions: this.markedPositions(id), orders: this.listOrders(id), fills: this.listFills(id), ledger: this.ledger(id) })).immediate();
  }
  listOrders(accountId?: string): PaperOrder[] {
    if (accountId !== undefined) this.accountRow(accountId);
    return (accountId === undefined ? this.db.prepare<[], OrderRow>('SELECT * FROM paper_orders ORDER BY accepted_sequence DESC').all() : this.db.prepare<[string], OrderRow>('SELECT * FROM paper_orders WHERE account_id=? ORDER BY accepted_sequence DESC').all(accountId)).map(orderDto);
  }
  listFills(accountId?: string): PaperFill[] {
    if (accountId !== undefined) this.accountRow(accountId);
    const select = 'SELECT f.*,o.provider,o.symbol,o.side FROM paper_fills f JOIN paper_orders o ON o.id=f.order_id';
    const rows = accountId === undefined ? this.db.prepare<[], FillRow>(`${select} ORDER BY o.accepted_sequence DESC`).all() : this.db.prepare<[string], FillRow>(`${select} WHERE f.account_id=? ORDER BY o.accepted_sequence DESC`).all(accountId);
    return rows.map(row => ({ id: row.id, orderId: row.order_id, accountId: row.account_id, market: { provider: row.provider, symbol: row.symbol }, side: row.side, quantity: row.quantity, price: row.price, fee: row.fee, currency: row.currency, sourceEventId: row.source_event_id, occurredAt: row.occurred_at, createdAt: row.created_at }));
  }
  private ledger(accountId: string): PaperLedgerEntry[] {
    return this.db.prepare<[string], LedgerRow>('SELECT * FROM paper_ledger WHERE account_id=? ORDER BY occurred_at,rowid').all(accountId).map(row => ({ id: row.id, accountId: row.account_id, fillId: row.fill_id, kind: row.kind, cashDelta: row.cash_delta, cashBalance: row.cash_balance, details: JSON.parse(row.details_json) as Record<string, unknown>, occurredAt: row.occurred_at }));
  }

  private replayContext(accountId: string, market: MarketRef, requireActive: boolean): ReplayContext {
    const session = this.db.prepare<[string], ReplayRow>('SELECT id,state,base_timeframe,cursor_time,to_time,markets_json FROM replay_sessions WHERE account_id=?').get(accountId);
    if (!session) throw new ApiError(409, 'REPLAY_SESSION_REQUIRED', 'Replay orders require a frozen server replay session.');
    if (requireActive && session.state !== 'active') throw new ApiError(409, 'REPLAY_STOPPED', 'Replay is stopped. Start a new replay session before placing orders.');
    const frozen = JSON.parse(session.markets_json) as { markets: ReplayMarket[]; series: ReplaySnapshot[] };
    if (!frozen.markets.some(item => item.market.provider === market.provider && item.market.symbol === market.symbol)) throw new ApiError(422, 'REPLAY_MARKET_NOT_SELECTED', 'Indicator secondary data does not grant replay trading authority. Select this market when starting replay.');
    const selectedTimeframes = frozen.markets.filter(item => item.market.provider === market.provider && item.market.symbol === market.symbol).map(item => item.timeframe);
    const matching = frozen.series.filter(item => item.market.provider === market.provider && item.market.symbol === market.symbol && (item.timeframe === session.base_timeframe || selectedTimeframes.includes(item.timeframe))).sort((a, b) => (fixedDuration(a.timeframe) ?? Infinity) - (fixedDuration(b.timeframe) ?? Infinity));
    const series = matching[0];
    if (!series) throw new ApiError(422, 'REPLAY_MARKET_NOT_LOADED', 'This market is not part of the frozen replay window.');
    let latest: Bar | undefined;
    for (const bar of series.bars) { if (nextBucket(bar.time, series.timeframe) <= session.cursor_time) latest = bar; else break; }
    const quote: Quote | null = latest ? { market, price: decimalString(new Decimal(latest.close)), observedAt: nextBucket(latest.time, series.timeframe), status: 'historical', changePercent: null } : null;
    return { session, series, quote };
  }

  private fresh(quote: Quote, now: number): boolean {
    let price: Decimal;
    try { price = financialDecimal(quote.price); } catch { return false; }
    return quote.market.provider !== 'csv' && quote.status === 'live' && price.isPositive() && Number.isSafeInteger(quote.observedAt) && quote.observedAt <= now && now - quote.observedAt <= 30_000 && this.feedStatus.get(`${quote.market.provider}:${quote.market.symbol}`) !== 'stale';
  }
  private async refreshMarks(accountId?: string): Promise<void> {
    if (accountId !== undefined) this.accountRow(accountId);
    const rows = accountId === undefined ? this.db.prepare<[], MarketRef>(`SELECT DISTINCT p.provider,p.symbol FROM paper_positions p JOIN paper_accounts a ON a.id=p.account_id WHERE a.mode='live'`).all() : this.db.prepare<[string], MarketRef>(`SELECT DISTINCT p.provider,p.symbol FROM paper_positions p JOIN paper_accounts a ON a.id=p.account_id WHERE a.mode='live' AND p.account_id=?`).all(accountId);
    await Promise.all(rows.map(async market => {
      const key = `${market.provider}:${market.symbol}`;
      try {
        const quote = await this.market.getQuote(market);
        const cached = this.quotes.get(key);
        if (!cached || quote.observedAt >= cached.observedAt) this.quotes.set(key, quote);
      } catch {
        const cached = this.quotes.get(key);
        if (cached) this.quotes.set(key, { ...cached, status: 'stale' });
      }
    }));
  }
  private markedPositions(accountId?: string): PaperPosition[] {
    const rows = accountId === undefined ? this.db.prepare<[], PositionRow>('SELECT * FROM paper_positions ORDER BY account_id,provider,symbol').all() : this.db.prepare<[string], PositionRow>('SELECT * FROM paper_positions WHERE account_id=? ORDER BY provider,symbol').all(accountId);
    return rows.map(row => {
      const account = this.accountRow(row.account_id);
      let quote = this.quotes.get(`${row.provider}:${row.symbol}`) ?? null;
      if (account.mode === 'replay') {
        try { quote = this.replayContext(account.id, { provider: row.provider, symbol: row.symbol }, false).quote; } catch { quote = null; }
      }
      const known = quote !== null && (account.mode === 'replay' || this.fresh(quote, this.clock()));
      const quantity = financialDecimal(row.quantity); const basis = financialDecimal(row.cost_basis);
      const value = known ? quantity.mul(financialDecimal(quote!.price)) : null;
      return { id: row.id, accountId: row.account_id, market: { provider: row.provider, symbol: row.symbol }, quantity: row.quantity, reservedQuantity: row.reserved_quantity, availableQuantity: decimalString(quantity.minus(row.reserved_quantity)), costBasis: row.cost_basis, averageCost: quantity.isZero() ? null : decimalString(basis.div(quantity)), realizedPnl: row.realized_pnl, unrealizedPnl: value === null ? null : decimalString(value.minus(basis)), marketValue: value === null ? null : decimalString(value), quoteObservedAt: quote?.observedAt ?? null, quoteStatus: quote === null ? 'unavailable' : account.mode === 'replay' ? 'historical' : known ? 'live' : 'stale', revision: row.revision };
    });
  }
  async listPositions(accountId?: string): Promise<PaperPosition[]> {
    await this.refreshMarks(accountId);
    return this.markedPositions(accountId);
  }

  async placeOrder(body: PaperOrderRequest, key: string): Promise<PaperOrder> {
    if (this.closed) throw new ApiError(503, 'PAPER_SERVICE_CLOSED', 'The paper service is shutting down.');
    if (!key || key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key of 1–200 visible ASCII characters.');
    if (!['buy', 'sell'].includes(body.side) || !['market', 'limit', 'stop'].includes(body.type)) throw new ApiError(400, 'INVALID_ORDER_TYPE', 'Only spot buy/sell market, limit and stop orders are supported.');
    if ((body.type === 'limit') !== (body.limitPrice !== undefined) || (body.type === 'stop') !== (body.stopPrice !== undefined)) throw new ApiError(400, 'INVALID_ORDER_PRICE', 'Provide only the price required by the selected limit or stop order type.');
    const quantity = checkedDecimal(body.quantity, 'Quantity', true);
    if (body.limitPrice !== undefined) checkedDecimal(body.limitPrice, 'Limit price', true);
    if (body.stopPrice !== undefined) checkedDecimal(body.stopPrice, 'Stop price', true);
    const hash = createHash('sha256').update(JSON.stringify({ accountId: body.accountId, market: { provider: body.market.provider, symbol: body.market.symbol }, side: body.side, type: body.type, quantity: body.quantity, limitPrice: body.limitPrice ?? null, stopPrice: body.stopPrice ?? null })).digest('hex');
    const existing = this.db.prepare<[string, string], OrderRow>('SELECT * FROM paper_orders WHERE account_id=? AND idempotency_key=?').get(body.accountId, key);
    if (existing) {
      if (existing.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different paper order.');
      return orderDto(existing);
    }
    const initialAccount = this.accountRow(body.accountId, true);
    let instrument: Instrument; let reference: Quote | null = null; let reason: string | null = null;
    if (initialAccount.mode === 'replay') {
      const context = this.replayContext(body.accountId, body.market, true); instrument = context.series.symbolInfo; reference = context.quote;
    } else {
      if (body.market.provider === 'csv') throw new ApiError(422, 'HISTORICAL_FEED', 'Imported datasets cannot fill live paper accounts. Start isolated replay instead.');
      instrument = await this.market.getInstrument(body.market);
      try { reference = await this.market.getQuote(body.market); this.quotes.set(`${body.market.provider}:${body.market.symbol}`, reference); } catch (error) {
        if (!(error instanceof ApiError) || ![429, 503].includes(error.statusCode)) throw error;
        reason = 'Waiting for an available live quote.';
      }
      if (reference && !this.fresh(reference, this.clock())) { reference = null; reason = 'Waiting for a fresh connected live quote.'; }
      if (body.type !== 'limit' && reference === null) throw new ApiError(503, 'PAPER_REFERENCE_UNAVAILABLE', reason ?? 'A fresh live reference quote is required for market and stop orders.');
    }
    const { order, events } = this.db.transaction(() => {
      const duplicate = this.db.prepare<[string, string], OrderRow>('SELECT * FROM paper_orders WHERE account_id=? AND idempotency_key=?').get(body.accountId, key);
      if (duplicate) {
        if (duplicate.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different paper order.');
        return { order: orderDto(duplicate), events: [] };
      }
      const account = this.accountRow(body.accountId, true);
      let now = this.clock();
      if (account.mode === 'replay') {
        const context = this.replayContext(body.accountId, body.market, true); instrument = context.series.symbolInfo; reference = context.quote; now = context.session.cursor_time;
        if (reference === null && body.type !== 'limit') throw new ApiError(422, 'REPLAY_REFERENCE_UNAVAILABLE', 'No completed replay bar is available for this market yet.');
      } else if (reference && !this.fresh(reference, now)) {
        reference = null; reason = 'Waiting for a fresh connected live quote.';
        if (body.type !== 'limit') throw new ApiError(503, 'PAPER_REFERENCE_UNAVAILABLE', reason);
      }
      if (instrument.quoteCurrency !== account.quote_currency) throw new ApiError(422, 'PAPER_CURRENCY_MISMATCH', `Account ${account.quote_currency} cannot trade ${instrument.quoteCurrency}; no currency conversion is performed.`);
      if (!paperStepAligned(quantity, instrument.quantityStep)) throw new ApiError(422, 'INVALID_QUANTITY_STEP', 'Quantity must be a positive exact multiple of the instrument quantity step.', { quantityStep: instrument.quantityStep });
      for (const value of [body.limitPrice, body.stopPrice]) if (value !== undefined && !paperStepAligned(financialDecimal(value), instrument.tickSize)) throw new ApiError(422, 'INVALID_PRICE_STEP', 'Order price must be a positive exact multiple of the instrument tick size.', { tickSize: instrument.tickSize });
      const position = this.db.prepare<[string, string, string], PositionRow>('SELECT * FROM paper_positions WHERE account_id=? AND provider=? AND symbol=?').get(account.id, body.market.provider, body.market.symbol);
      const reserve = body.side === 'buy' ? paperBuyReservation(body, reference ? financialDecimal(reference.price) : null, account.commission_bps, account.slippage_bps) : new Decimal(0);
      if (reserve.gt(financialDecimal(account.cash_balance).minus(account.reserved_cash))) throw new ApiError(422, 'INSUFFICIENT_PAPER_CASH', 'Available paper cash cannot cover the order reservation including fees and slippage.');
      if (body.side === 'sell' && (!position || quantity.gt(financialDecimal(position.quantity).minus(position.reserved_quantity)))) throw new ApiError(422, 'INSUFFICIENT_PAPER_HOLDINGS', 'Spot paper accounts cannot short or sell reserved holdings.');
      const sequence = this.db.prepare<[], { sequence: number }>('SELECT COALESCE(MAX(accepted_sequence),0)+1 AS sequence FROM paper_orders').get()!.sequence;
      const id = randomUUID();
      this.db.prepare('INSERT INTO paper_orders(id,account_id,accepted_sequence,idempotency_key,request_hash,provider,symbol,side,type,quantity,limit_price,stop_price,reserved_cash,reserved_quantity,state,waiting_reason,accepted_at,accepted_reference_event_id,accepted_reference_observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'open\',?,?,?,?)').run(id, account.id, sequence, key, hash, body.market.provider, body.market.symbol, body.side, body.type, body.quantity, body.limitPrice ?? null, body.stopPrice ?? null, decimalString(reserve), body.side === 'sell' ? body.quantity : '0', reason ?? (account.mode === 'replay' ? 'Waiting for the next replay bar.' : 'Waiting for a new live quote after acceptance.'), now, reference ? paperQuoteEventId(reference) : null, reference?.observedAt ?? null);
      this.db.prepare('UPDATE paper_accounts SET reserved_cash=? WHERE id=?').run(decimalString(financialDecimal(account.reserved_cash).plus(reserve)), account.id);
      if (body.side === 'sell') this.db.prepare('UPDATE paper_positions SET reserved_quantity=?,revision=revision+1 WHERE id=?').run(decimalString(financialDecimal(position!.reserved_quantity).plus(quantity)), position!.id);
      return { order: orderDto(this.orderRow(id)), events: [this.changed(account.id)] };
    }).immediate();
    this.publish(events); this.syncSubscriptions(); return order;
  }

  private release(order: OrderRow): void {
    const account = this.accountRow(order.account_id);
    this.db.prepare('UPDATE paper_accounts SET reserved_cash=? WHERE id=?').run(decimalString(financialDecimal(account.reserved_cash).minus(order.reserved_cash)), account.id);
    if (order.side === 'sell') {
      const position = this.db.prepare<[string, string, string], PositionRow>('SELECT * FROM paper_positions WHERE account_id=? AND provider=? AND symbol=?').get(account.id, order.provider, order.symbol)!;
      this.db.prepare('UPDATE paper_positions SET reserved_quantity=?,revision=revision+1 WHERE id=?').run(decimalString(financialDecimal(position.reserved_quantity).minus(order.reserved_quantity)), position.id);
    }
  }
  cancelOrder(id: string): PaperOrder {
    const { order, events } = this.db.transaction(() => {
      const current = this.orderRow(id);
      if (current.state === 'cancelled') return { order: orderDto(current), events: [] };
      if (current.state !== 'open') throw new ApiError(409, 'PAPER_ORDER_COMPLETED', 'Only an open paper order can be cancelled.');
      this.release(current);
      this.db.prepare('UPDATE paper_orders SET state=\'cancelled\',reserved_cash=\'0\',reserved_quantity=\'0\',waiting_reason=NULL,completed_at=? WHERE id=?').run(this.clock(), id);
      return { order: orderDto(this.orderRow(id)), events: [this.changed(current.account_id)] };
    }).immediate();
    this.publish(events); this.syncSubscriptions(); return order;
  }
  resetAccount(id: string): PaperAccountView {
    const { view, events } = this.db.transaction(() => {
      const account = this.accountRow(id, true);
      if (account.mode === 'replay') throw new ApiError(409, 'REPLAY_REWIND_REQUIRED', 'Replay accounts cannot be reset in place. Stop and start a new session to rewind.');
      const now = this.clock();
      for (const order of this.db.prepare<[string], OrderRow>('SELECT * FROM paper_orders WHERE account_id=? AND state=\'open\' ORDER BY accepted_sequence').all(id)) {
        this.release(order); this.db.prepare('UPDATE paper_orders SET state=\'cancelled\',reserved_cash=\'0\',reserved_quantity=\'0\',waiting_reason=NULL,completed_at=? WHERE id=?').run(now, order.id);
      }
      this.db.prepare('UPDATE paper_accounts SET archived_at=? WHERE id=?').run(now, id);
      const oldEvent = this.changed(id, now);
      const view = this.insertAccount({ name: account.name, quoteCurrency: account.quote_currency, initialBalance: account.initial_balance, commissionBps: account.commission_bps, slippageBps: account.slippage_bps }, 'live');
      this.db.prepare('INSERT INTO paper_ledger(id,account_id,kind,cash_delta,cash_balance,details_json,occurred_at) VALUES (?,?,\'reset\',\'0\',?,?,?)').run(randomUUID(), id, account.cash_balance, JSON.stringify({ replacementAccountId: view.account.id, archived: true }), now);
      return { view, events: [oldEvent, this.events.record('paper.changed', view.account.id, view.account.revision)] };
    }).immediate();
    this.publish(events); this.syncSubscriptions(); return view;
  }

  private applyFill(order: OrderRow, rawPrice: Decimal, sourceEventId: string, occurredAt: number): void {
    const account = this.accountRow(order.account_id, true);
    const price = paperExecutionPrice(rawPrice, order.side, account.slippage_bps, order.type === 'limit' ? order.limit_price! : undefined);
    const quantity = financialDecimal(order.quantity); const notional = quantity.mul(price); const fee = paperFee(notional, account.commission_bps);
    const position = this.db.prepare<[string, string, string], PositionRow>('SELECT * FROM paper_positions WHERE account_id=? AND provider=? AND symbol=?').get(account.id, order.provider, order.symbol);
    const affordable = financialDecimal(account.cash_balance).minus(account.reserved_cash).plus(order.reserved_cash);
    if ((order.side === 'buy' && notional.plus(fee).gt(affordable)) || (order.side === 'sell' && (!position || quantity.gt(financialDecimal(position.quantity).minus(position.reserved_quantity).plus(order.reserved_quantity))))) {
      this.release(order);
      this.db.prepare('UPDATE paper_orders SET state=\'rejected\',reserved_cash=\'0\',reserved_quantity=\'0\',waiting_reason=?,completed_at=? WHERE id=?').run(order.side === 'buy' ? 'Price gap exceeds reserved plus available cash.' : 'Reserved holdings are no longer available.', occurredAt, order.id);
      return;
    }
    const result = paperSpotFill({ cashBalance: account.cash_balance, quantity: position?.quantity ?? '0', costBasis: position?.cost_basis ?? '0', realizedPnl: position?.realized_pnl ?? '0' }, order.side, quantity, price, account.commission_bps);
    const remainingReservedCash = decimalString(financialDecimal(account.reserved_cash).minus(order.reserved_cash));
    const remainingReservedQuantity = decimalString(financialDecimal(position?.reserved_quantity ?? '0').minus(order.reserved_quantity));
    this.db.prepare('UPDATE paper_accounts SET cash_balance=?,reserved_cash=? WHERE id=?').run(result.cashBalance, remainingReservedCash, account.id);
    if (position) this.db.prepare('UPDATE paper_positions SET quantity=?,reserved_quantity=?,cost_basis=?,realized_pnl=?,revision=revision+1 WHERE id=?').run(result.quantity, remainingReservedQuantity, result.costBasis, result.realizedPnl, position.id);
    else this.db.prepare('INSERT INTO paper_positions(id,account_id,provider,symbol,quantity,reserved_quantity,cost_basis,realized_pnl,revision) VALUES (?,?,?,?,?,?,?,?,1)').run(randomUUID(), account.id, order.provider, order.symbol, result.quantity, remainingReservedQuantity, result.costBasis, result.realizedPnl);
    const fillId = randomUUID(); const createdAt = this.clock();
    this.db.prepare('INSERT INTO paper_fills(id,order_id,account_id,quantity,price,fee,currency,source_event_id,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(fillId, order.id, account.id, order.quantity, decimalString(price), result.fee, account.quote_currency, sourceEventId, occurredAt, createdAt);
    this.db.prepare('INSERT INTO paper_ledger(id,account_id,fill_id,kind,cash_delta,cash_balance,details_json,occurred_at) VALUES (?,?,?,\'fill\',?,?,?,?)').run(randomUUID(), account.id, fillId, result.cashDelta, result.cashBalance, JSON.stringify({ orderId: order.id, market: { provider: order.provider, symbol: order.symbol }, side: order.side, quantity: order.quantity, price: decimalString(price), fee: result.fee, currency: account.quote_currency, realizedDelta: result.realizedDelta }), occurredAt);
    this.db.prepare('UPDATE paper_orders SET state=\'filled\',reserved_cash=\'0\',reserved_quantity=\'0\',waiting_reason=NULL,completed_at=? WHERE id=?').run(occurredAt, order.id);
  }

  processQuote(quote: Quote, receivedAt = this.clock()): void {
    if (this.closed || quote.market.provider === 'csv') return;
    const key = `${quote.market.provider}:${quote.market.symbol}`;
    const cached = this.quotes.get(key);
    if (!cached || quote.observedAt >= cached.observedAt) this.quotes.set(key, quote);
    if (!this.fresh(quote, this.clock()) || !Number.isSafeInteger(receivedAt) || receivedAt > this.clock()) {
      this.waiting(quote.market, 'Waiting for a fresh connected live quote.'); return;
    }
    const eventId = paperQuoteEventId(quote);
    const events = this.db.transaction(() => {
      const changes: InvalidationEvent[] = [];
      const accounts = this.db.prepare<[string, string, string, string], AccountRow>(`SELECT DISTINCT a.* FROM paper_accounts a WHERE a.mode='live' AND a.archived_at IS NULL AND (EXISTS (SELECT 1 FROM paper_orders o WHERE o.account_id=a.id AND o.provider=? AND o.symbol=? AND o.state='open') OR EXISTS (SELECT 1 FROM paper_positions p WHERE p.account_id=a.id AND p.provider=? AND p.symbol=? AND p.quantity!='0'))`).all(quote.market.provider, quote.market.symbol, quote.market.provider, quote.market.symbol);
      for (const account of accounts) {
        const watermark = this.db.prepare<[string, string, string], Watermark>('SELECT source_event_id,observed_at FROM paper_quote_watermarks WHERE account_id=? AND provider=? AND symbol=?').get(account.id, quote.market.provider, quote.market.symbol);
        if (watermark && quote.observedAt < watermark.observed_at) continue;
        const inserted = this.db.prepare('INSERT OR IGNORE INTO paper_processed_quotes(account_id,provider,symbol,source_event_id,observed_at) VALUES (?,?,?,?,?)').run(account.id, quote.market.provider, quote.market.symbol, eventId, quote.observedAt);
        if (inserted.changes === 0) continue;
        this.db.prepare('INSERT INTO paper_quote_watermarks(account_id,provider,symbol,source_event_id,observed_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id,provider,symbol) DO UPDATE SET source_event_id=excluded.source_event_id,observed_at=excluded.observed_at').run(account.id, quote.market.provider, quote.market.symbol, eventId, quote.observedAt);
        const orders = this.db.prepare<[string, string, string], OrderRow>('SELECT * FROM paper_orders WHERE account_id=? AND provider=? AND symbol=? AND state=\'open\' ORDER BY accepted_sequence').all(account.id, quote.market.provider, quote.market.symbol);
        for (const order of orders) {
          if (receivedAt < order.accepted_at || eventId === order.accepted_reference_event_id || (order.accepted_reference_observed_at !== null && quote.observedAt < order.accepted_reference_observed_at)) continue;
          const rawPrice = paperQuotePrice(orderDto(order), financialDecimal(quote.price));
          if (rawPrice === null) this.db.prepare('UPDATE paper_orders SET waiting_reason=? WHERE id=?').run(order.type === 'limit' ? 'Waiting for a quote at or better than the limit.' : 'Waiting for the stop crossing.', order.id);
          else this.applyFill(order, rawPrice, eventId, receivedAt);
        }
        changes.push(this.changed(account.id));
      }
      return changes;
    }).immediate();
    this.publish(events); this.syncSubscriptions();
  }

  processReplayBar(accountId: string, market: MarketRef, bar: Bar, closeBoundary: number): void {
    const events = this.db.transaction(() => {
      const account = this.accountRow(accountId, true);
      if (account.mode !== 'replay') throw new ApiError(422, 'REPLAY_ACCOUNT_REQUIRED', 'Replay bars can only fill the isolated replay account.');
      const context = this.replayContext(accountId, market, true);
      if (context.series.symbolInfo.quoteCurrency !== account.quote_currency) return [];
      const barClose = nextBucket(bar.time, context.series.timeframe);
      if (barClose <= context.session.cursor_time) return [];
      if (barClose > closeBoundary || closeBoundary > context.session.to_time) throw new ApiError(409, 'REPLAY_CURSOR_CONFLICT', 'The frozen fill bar must close within the newly acknowledged replay interval.');
      const frozen = context.series.bars.find(item => item.time === bar.time);
      if (!frozen || ['open', 'high', 'low', 'close', 'volume'].some(key => frozen[key as keyof Bar] !== bar[key as keyof Bar])) throw new ApiError(409, 'REPLAY_SNAPSHOT_CONFLICT', 'Replay fills require the exact frozen raw bar.');
      const eventId = `replay:${context.session.id}:${market.provider}:${market.symbol}:${bar.time}`;
      const inserted = this.db.prepare('INSERT OR IGNORE INTO paper_processed_quotes(account_id,provider,symbol,source_event_id,observed_at) VALUES (?,?,?,?,?)').run(accountId, market.provider, market.symbol, eventId, closeBoundary);
      if (inserted.changes === 0) return [];
      this.db.prepare('INSERT INTO paper_quote_watermarks(account_id,provider,symbol,source_event_id,observed_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id,provider,symbol) DO UPDATE SET source_event_id=excluded.source_event_id,observed_at=excluded.observed_at').run(accountId, market.provider, market.symbol, eventId, closeBoundary);
      const orders = this.db.prepare<[string, string, string], OrderRow>('SELECT * FROM paper_orders WHERE account_id=? AND provider=? AND symbol=? AND state=\'open\' ORDER BY accepted_sequence').all(accountId, market.provider, market.symbol);
      for (const order of orders) {
        if (order.accepted_at > bar.time) continue;
        const rawPrice = paperReplayPrice(orderDto(order), frozen);
        if (rawPrice !== null) this.applyFill(order, rawPrice, eventId, bar.time);
      }
      return [this.changed(accountId)];
    }).immediate();
    this.publish(events);
  }

  private waiting(market: MarketRef, reason: string): void {
    const events = this.db.transaction(() => {
      const accounts = this.db.prepare<[string, string, string, string], { id: string }>(`SELECT DISTINCT a.id FROM paper_accounts a LEFT JOIN paper_orders o ON o.account_id=a.id LEFT JOIN paper_positions p ON p.account_id=a.id WHERE a.mode='live' AND a.archived_at IS NULL AND ((o.provider=? AND o.symbol=? AND o.state='open') OR (p.provider=? AND p.symbol=? AND p.quantity!='0'))`).all(market.provider, market.symbol, market.provider, market.symbol);
      for (const account of accounts) this.db.prepare('UPDATE paper_orders SET waiting_reason=? WHERE account_id=? AND provider=? AND symbol=? AND state=\'open\'').run(reason, account.id, market.provider, market.symbol);
      return accounts.map(account => this.changed(account.id));
    }).immediate();
    this.publish(events);
  }
  private syncSubscriptions(): void {
    if (this.closed) return;
    const markets = this.db.prepare<[], MarketRef>(`SELECT o.provider,o.symbol FROM paper_orders o JOIN paper_accounts a ON a.id=o.account_id WHERE o.state='open' AND a.mode='live' AND a.archived_at IS NULL UNION SELECT p.provider,p.symbol FROM paper_positions p JOIN paper_accounts a ON a.id=p.account_id WHERE p.quantity!='0' AND a.mode='live' AND a.archived_at IS NULL`).all();
    const wanted = new Set(markets.map(item => `${item.provider}:${item.symbol}`));
    for (const [key, release] of this.subscriptions) if (!wanted.has(key)) { release?.(); this.subscriptions.delete(key); this.feedStatus.delete(key); }
    for (const market of markets) {
      const key = `${market.provider}:${market.symbol}`;
      if (this.subscriptions.has(key) || market.provider === 'csv') continue;
      // Mark before subscribe: transports may synchronously emit a warmup quote.
      this.subscriptions.set(key, null);
      try {
        const release = this.market.subscribeBars(market, '1', event => {
          if (event.kind === 'quote') this.processQuote(event.quote, this.clock());
          else if (event.kind === 'status') {
            this.feedStatus.set(key, event.status);
            if (event.status === 'stale') {
              const quote = this.quotes.get(key); if (quote) this.quotes.set(key, { ...quote, status: 'stale' });
              this.waiting(market, 'Waiting for the live provider to reconnect.');
            }
          }
        });
        if (this.subscriptions.has(key)) this.subscriptions.set(key, release); else release();
      } catch {
        this.subscriptions.delete(key); this.feedStatus.set(key, 'stale'); this.waiting(market, 'Live provider unavailable; waiting for a new connected quote.');
      }
    }
  }
}
