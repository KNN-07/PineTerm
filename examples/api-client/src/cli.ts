import { randomUUID } from 'node:crypto';
import type { ProviderId } from '@pineterm/contracts';
import { FinanceClient } from './index.js';

const url = process.env.PINETERM_API_URL;
const token = process.env.PINETERM_API_TOKEN;
const accountId = process.env.PINETERM_API_PAPER_ACCOUNT_ID;
const quantity = process.env.PINETERM_API_QUANTITY;
const limitPrice = process.env.PINETERM_API_LIMIT_PRICE;
const provider = process.env.PINETERM_API_PROVIDER ?? 'coinbase';
const symbol = process.env.PINETERM_API_SYMBOL ?? 'BTC-USD';
const timeframe = process.env.PINETERM_API_TIMEFRAME ?? '1';
if (!url || !token || !accountId || !quantity || !limitPrice) throw new Error('Set PINETERM_API_URL, PINETERM_API_TOKEN, PINETERM_API_PAPER_ACCOUNT_ID, PINETERM_API_QUANTITY and PINETERM_API_LIMIT_PRICE securely in the environment. This example places/cancels PAPER orders only.');
if (!['coinbase', 'binance'].includes(provider)) throw new Error('The paper example requires an explicit live Coinbase or Binance venue.');
const client = new FinanceClient({ url, token });
const market = { provider: provider as ProviderId, symbol };
const bars = await client.getBars({ ...market, timeframe, limit: 2 });
console.log(JSON.stringify({ mode: 'paper-only', market, timeframe, asOf: bars.asOf, status: bars.status, bars: bars.bars }));
const placed = await client.placePaperOrder({ accountId, market, side: 'buy', type: 'limit', quantity, limitPrice }, 'api-example:' + randomUUID());
console.log(JSON.stringify({ orderId: placed.id, state: placed.state, reservedCash: placed.reservedCash }));
if (placed.state === 'open') {
  const cancelled = await client.cancelPaperOrder(placed.id);
  console.log(JSON.stringify({ orderId: cancelled.id, state: cancelled.state }));
}
const portfolio = await client.getPaperAccount(accountId);
const fills = await client.getPaperFills(accountId);
console.log(JSON.stringify({ accountId, cash: portfolio.account.cashBalance, quoteCurrency: portfolio.account.quoteCurrency, positions: portfolio.positions, fills }));
