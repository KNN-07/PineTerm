import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { BarPage } from '../packages/contracts/src/market.js';

const url = process.env.PINETERM_SMOKE_URL ?? 'http://127.0.0.1:3000';
let token = process.env.PINETERM_SMOKE_TOKEN;
let cookie: string | undefined;
let csrfToken: string | undefined;
let temporaryKeyId: string | undefined;
const password = process.env.PINETERM_SMOKE_ADMIN_PASSWORD ?? process.env.PINETERM_ADMIN_PASSWORD;
if (!token) {
  if (!password) throw new Error('Set PINETERM_SMOKE_TOKEN or PINETERM_SMOKE_ADMIN_PASSWORD securely in the environment');
  const login = await fetch(url + '/api/v1/session', { method: 'POST', headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 200, 'Provider smoke administrator login failed');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  csrfToken = (await login.json() as { csrfToken: string }).csrfToken;
  const created = await fetch(url + '/api/v1/api-keys', { method: 'POST', headers: { Cookie: cookie, Origin: new URL(url).origin, 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name: 'temporary provider acceptance', scopes: ['market:read'] }) });
  assert.equal(created.status, 201, 'Provider smoke temporary scope creation failed');
  const key = await created.json() as { key: { id: string }; token: string };
  temporaryKeyId = key.key.id;
  token = key.token;
}
let failed = false;
try {
  for (const [provider, symbol] of [['binance', 'BTCUSDT'], ['coinbase', 'BTC-USD']]) {
    try {
      const response = await fetch(url + `/api/v1/bars?provider=${provider}&symbol=${symbol}&timeframe=1&limit=2`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const page = await response.json() as BarPage;
      assert.equal(page.status, 'live', JSON.stringify(page.providerError));
      assert.ok(page.bars.length > 0, 'No real candles returned');
      for (const [index, bar] of page.bars.entries()) {
        assert.ok([bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite));
        assert.ok(bar.close > 0 && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close));
        if (index) assert.ok(bar.time > page.bars[index - 1].time);
      }
      console.log(`${provider}:${symbol}: actual API OHLCV`, JSON.stringify(page.bars));
      const socket = new WebSocket(url.replace(/^http/, 'ws') + '/api/v1/stream', { headers: { Authorization: `Bearer ${token}`, Origin: new URL(url).origin } });
      const update = Promise.withResolvers<unknown>();
      const deadline = setTimeout(() => update.reject(new Error('No real upstream candle update within 45 seconds')), 45000);
      socket.on('error', update.reject);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', channel: 'bars', market: { provider, symbol }, timeframe: '1' })));
      let firstUpdate: { bar: { time: number; close: number }; receivedAt: number } | undefined;
      socket.on('message', bytes => {
        const event = JSON.parse(bytes.toString());
        if (event.type !== 'bar' || event.payload.kind !== 'update' || event.payload.bar.time < page.bars.at(-1)!.time || Date.now() - event.payload.receivedAt > 30000) return;
        if (!firstUpdate) firstUpdate = event.payload;
        else if (event.payload.receivedAt > firstUpdate.receivedAt) update.resolve({ first: firstUpdate, subsequent: event.payload });
      });
      try {
        console.log(`${provider}:${symbol}: observed upstream stream update`, JSON.stringify(await update.promise));
        const quoteResponse: Response = await fetch(url + `/api/v1/quotes?provider=${provider}&symbol=${symbol}`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(quoteResponse.status, 200);
        const quote = await quoteResponse.json() as { price: string; observedAt: number; status: string };
        assert.equal(quote.status, 'live');
        assert.ok(Number(quote.price) > 0 && Date.now() - quote.observedAt <= 30000);
        console.log(`${provider}:${symbol}: fresh observed quote`, JSON.stringify(quote));
      } finally { clearTimeout(deadline); socket.close(); }
    } catch (error) {
      failed = true;
      console.error(`${provider}:${symbol}: BLOCKED — ${error instanceof Error ? error.message : 'Unknown provider failure'}`);
    }
  }
} finally {
  if (temporaryKeyId && cookie && csrfToken) {
    await fetch(url + '/api/v1/api-keys/' + temporaryKeyId, { method: 'DELETE', headers: { Cookie: cookie, Origin: new URL(url).origin, 'x-csrf-token': csrfToken } });
    await fetch(url + '/api/v1/session', { method: 'DELETE', headers: { Cookie: cookie, Origin: new URL(url).origin, 'x-csrf-token': csrfToken } });
  }
}
if (failed) process.exitCode = 1;
