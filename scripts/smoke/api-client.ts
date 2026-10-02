import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ApiKeyScope, CreateApiKeyResponse, PaperAccountView } from '../../packages/contracts/src/index.js';
import type { FixtureTransport } from '../../tests/fixtures/market.js';
import { FinanceApiError, FinanceClient } from '../../examples/api-client/src/index.js';

export async function runApiClientScenario(url: string, headers: Record<string, string>, fixture: FixtureTransport, advanceClock: (time: number) => void): Promise<void> {
  const keys: CreateApiKeyResponse[] = [];
  const { 'Content-Type': _contentType, ...plainHeaders } = headers;
  try {
    for (const scopes of [['market:read', 'paper:read', 'paper:trade'], ['market:read', 'paper:read']] as ApiKeyScope[][]) {
      const created = await fetch(url + '/api/v1/api-keys', { method: 'POST', headers, body: JSON.stringify({ name: 'Actual finance client acceptance', scopes }) });
      assert.equal(created.status, 201, await created.clone().text());
      keys.push(await created.json() as CreateApiKeyResponse);
    }
    const client = new FinanceClient({ url, token: keys[0]!.token });
    const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
    advanceClock(fixture.clock() + 1000);
    fixture.emit('1', { kind: 'quote', quote: { market, price: '10', observedAt: fixture.clock(), status: 'live', changePercent: null } });
    const account = await client.createPaperAccount({ name: 'Scoped CLI paper-only account', quoteCurrency: 'USD', initialBalance: '1000', commissionBps: '0', slippageBps: '0' });
    const completed = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../examples/api-client/src/cli.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PINETERM_API_URL: url, PINETERM_API_TOKEN: keys[0]!.token, PINETERM_API_PAPER_ACCOUNT_ID: account.account.id, PINETERM_API_QUANTITY: '2', PINETERM_API_LIMIT_PRICE: '1', PINETERM_API_PROVIDER: 'coinbase', PINETERM_API_SYMBOL: 'BTC-USD', PINETERM_API_TIMEFRAME: '1' },
    });
    let stdout = ''; let stderr = ''; let tooLarge = false;
    child.stdout.on('data', bytes => { stdout += String(bytes); if (Buffer.byteLength(stdout) > 1024 * 1024) { tooLarge = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', bytes => { stderr += String(bytes); if (Buffer.byteLength(stderr) > 1024 * 1024) { tooLarge = true; child.kill('SIGKILL'); } });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', completed.reject);
    child.on('close', code => completed.resolve({ code, stdout, stderr }));
    let result: { code: number | null; stdout: string; stderr: string };
    try { result = await completed.promise; } finally { clearTimeout(deadline); }
    assert.equal(tooLarge, false, 'Finance CLI exceeded bounded output');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes(keys[0]!.token), false, 'Finance CLI exposed its bearer token');
    const observations = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(observations[0]!.mode, 'paper-only');
    assert.equal(observations[0]!.status, 'live');
    assert.deepEqual(observations[0]!.market, market);
    assert.equal(observations[1]!.state, 'open');
    assert.equal(observations[1]!.reservedCash, '2');
    assert.equal(observations[2]!.state, 'cancelled');
    assert.equal(observations[2]!.orderId, observations[1]!.orderId);
    const persisted = await client.getPaperAccount(account.account.id);
    assert.equal(persisted.account.cashBalance, '1000'); assert.equal(persisted.account.reservedCash, '0');
    assert.deepEqual(persisted.fills, []);
    const readonlyClient = new FinanceClient({ url, token: keys[1]!.token });
    assert.equal((await readonlyClient.getPaperAccount(account.account.id)).account.id, account.account.id);
    let rejected: unknown;
    try { await readonlyClient.placePaperOrder({ accountId: account.account.id, market, side: 'buy', type: 'limit', quantity: '1', limitPrice: '1' }, 'readonly-must-not-trade'); }
    catch (error) { rejected = error; }
    assert.ok(rejected instanceof FinanceApiError && rejected.status === 403, 'Read-only finance key must not place a paper order');
    const after = await client.getPaperAccount(account.account.id) as PaperAccountView;
    assert.equal(after.orders.length, 1); assert.equal(after.orders[0]!.state, 'cancelled');
    console.log('api-client: actual Node CLI/scoped HTTP bars, limit reservation2, cancel same order, cash1000/fills0, read-only key403; no funded venue or secret output');
  } finally {
    for (const key of keys) assert.equal((await fetch(url + '/api/v1/api-keys/' + key.key.id, { method: 'DELETE', headers: plainHeaders })).status, 204);
  }
}
