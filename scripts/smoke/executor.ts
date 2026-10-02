import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { FinanceClient } from '../../examples/api-client/src/index.js';
import { ExecutorClient } from '../../examples/executor-client/src/index.js';
import type { AlertCommand, AlertDefinition, AlertEvent, Bar, ExecutionPolicy, ExecutorClaim, ExecutorControl, ExecutorLease, ExecutorRecord, LiveIntent, OrderIntentRequest, RiskUsage, ScriptRevision } from '../../packages/contracts/src/index.js';
import type { FixtureTransport } from '../../tests/fixtures/market.js';

interface Recording { label: string; submissions: Array<{ clientOrderId: string; market: unknown; side: string; protectedCap: string | null }>; commands: Array<{ command: string; stage: string; clientOrderId: string }>; orders: Record<string, { reply: { externalOrderId?: string; fills: Array<{ externalFillId: string; quantity: string; price: string; fee: string; currency: string; time: number }> } }> }
/** Actual HTTP + Node subprocess + private client SQLite; expressly NOT venue/money acceptance. */
export async function runExecutorScenario(url: string, headers: Record<string, string>, fixture: FixtureTransport, advanceClock: (value: number) => void, restart: () => Promise<void>, idle: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pineterm-recording-executor-'));
  const driver = fileURLToPath(new URL('../../tests/fixtures/recording-executor-driver.mjs', import.meta.url));
  const { 'Content-Type': _contentType, ...plain } = headers;
  const market = { provider: 'coinbase' as const, symbol: 'BTC-USD' };
  const refresh = (price = '10'): void => { fixture.quote = { market, price, observedAt: fixture.clock(), status: 'live', changePercent: null }; fixture.emit('1', { kind: 'quote', quote: fixture.quote }); };
  advanceClock(fixture.clock() + 60001); refresh(); await idle();
  const request = async <T>(path: string, method = 'GET', body?: unknown, auth: Record<string,string> = plain, key?: string): Promise<T> => {
    const response = await fetch(url + '/api/v1' + path, { method, headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`); return (text ? JSON.parse(text) : undefined) as T;
  };
  const deny = async (body: unknown, status: number, key: string = randomUUID()): Promise<void> => {
    const response = await fetch(url + '/api/v1/order-intents', { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body) });
    assert.equal(response.status, status, await response.text());
  };
  const executor = (await request<{ executor: ExecutorRecord }>('/executors','POST',{ name: 'LOCAL recording only — no exchange connection', enabled: true })).executor;
  const token = (await request<{ token: string }>('/api-keys','POST',{ name: 'Local recording executor bound key', scopes: ['executor:claim','executor:report'], executorId: executor.id })).token;
  const bound = { authorization: 'Bearer ' + token };
  const api = new FinanceClient({ url, token });
  const body = (changes: Partial<OrderIntentRequest> = {}): OrderIntentRequest => ({ executorId: executor.id, market, side: 'buy', type: 'market', quantity: '1', expiresAt: fixture.clock() + 60000, ...changes });
  const policy = async (enabled: boolean, changes: Partial<ExecutionPolicy> = {}): Promise<ExecutionPolicy> => {
    const current = await request<ExecutionPolicy>('/execution-policy');
    return request<ExecutionPolicy>('/execution-policy','PUT',enabled ? { enabled: true, revision: current.revision, allowlist: [{ market, sides: ['buy','sell'] }], quoteLimits: [{ quoteCurrency: 'USD', perOrderNotional: '100', rolling24hNotional: '200' }], maxPending: 1, maxDeviationBps: '100', ...changes } : { enabled: false, revision: current.revision });
  };
  const create = async (value = body(), key: string = randomUUID()): Promise<LiveIntent> => (await request<{ intent: LiveIntent }>('/order-intents','POST',value,plain,key)).intent;
  const get = async (id: string): Promise<LiveIntent> => (await request<{ intent: LiveIntent }>('/order-intents/' + id)).intent;
  const recorderPath = join(directory, 'recording.json');
  const recordings = async (path = recorderPath): Promise<Recording> => JSON.parse(await readFile(path, 'utf8')) as Recording;
  let client: ExecutorClient | null = null;
  try {
    const initial = await request<ExecutionPolicy>('/execution-policy'); assert.equal(initial.enabled, false);
    await deny(body(),403);
    client = new ExecutorClient({ api, executorId: executor.id, driver: process.execPath, driverArgs: [driver,'--state',recorderPath,'--mode','filled','--price','10'], statePath: join(directory,'filled.sqlite') });
    assert.deepEqual(await client.cycle(), { intentId: null, state: null, unresolved: false });
    await assert.rejects(readFile(recorderPath, 'utf8'), { code: 'ENOENT' });
    const action = { executorId: executor.id, market, side: 'buy' as const, type: 'market' as const, quantity: '1' };
    const alertBody: AlertCommand = { name: 'Fixed one-unit action; notification pause independent', market, timeframe: '1', mode: 'quote', frequency: 'once', enabled: true, condition: { kind: 'price', operator: 'crosses_above', price: '11' }, destinations: [], liveAction: action };
    const alert = (await request<{ alert: AlertDefinition }>('/alerts','POST',alertBody)).alert; await idle();
    await policy(true);
    const readonly = (await request<{ token: string }>('/api-keys','POST',{ name: 'No live trade authority', scopes: ['market:read'] })).token;
    const readDenied = await fetch(url + '/api/v1/order-intents', { method: 'POST', headers: { authorization: 'Bearer ' + readonly, 'Content-Type': 'application/json', 'Idempotency-Key': 'read-denied' }, body: JSON.stringify(body()) }); assert.equal(readDenied.status,403);
    const unauth = await fetch(url + '/api/v1/order-intents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unauth' }, body: JSON.stringify(body()) }); assert.equal(unauth.status,401);
    for (const [change,status] of [ [{ quantity: '11' },422], [{ quantity: '0.1' },422], [{ expiresAt: fixture.clock() },422], [{ expiresAt: fixture.clock() + 60001 },422], [{ market: { provider: 'csv', symbol: randomUUID() } },422], [{ origin: 'replay' },400], [{ origin: 'backtest' },400], [{ sourceEventId: randomUUID() },400], [{ type: 'limit', limitPrice: '10.001' },422] ] as const) await deny({ ...body(), ...change },status);
    advanceClock(fixture.clock() + 30001); await idle(); await deny(body(),503); refresh(); await idle();
    const original = body(); const intent = await create(original, 'recording-roundtrip'); assert.equal(intent.risk.requestedNotional,'10.1');
    assert.equal((await create(original,'recording-roundtrip')).id,intent.id);
    const filled = await client.cycle(); assert.deepEqual(filled,{ intentId: intent.id, state: 'filled', unresolved: false });
    const recording = await recordings(); assert.equal(recording.label,'LOCAL RECORDING DRIVER; NO EXCHANGE CONNECTION'); assert.equal(recording.submissions.length,1); assert.equal(recording.submissions[0].clientOrderId,intent.id); assert.equal(recording.submissions[0].protectedCap,'10.1');
    const observed = await get(intent.id); assert.equal(observed.filledQuantity,'1'); assert.equal(observed.reports[0].fills[0].price,'10');
    const publicJSON = JSON.stringify(observed); assert.equal(publicJSON.includes('leaseToken'),false);
    // Exercise the real persisted client report, not an echoed fixture expectation.
    const clientDb = new Database(join(directory,'filled.sqlite'),{ readonly: true });
    const stored = clientDb.prepare('SELECT body_json FROM reports WHERE intent_id=?').get(intent.id) as { body_json: string }; clientDb.close();
    const duplicate = (await request<{ intent: LiveIntent }>('/order-intents/' + intent.id + '/reports','POST',JSON.parse(stored.body_json),bound)).intent;
    assert.equal(duplicate.id,intent.id); assert.equal(duplicate.filledQuantity,'1');
    assert.equal((await request<{ positions: Array<{ netQuantity: string }> }>('/reported-positions')).positions.find(position => position.netQuantity === '1')?.netQuantity,'1');
    await client.close(); client = null;

    // Concurrent creates reserve the same global pending slot inside immediate transactions.
    const simultaneous = await Promise.all([1,2].map(() => fetch(url + '/api/v1/order-intents',{ method:'POST',headers:{ ...headers,'Idempotency-Key':randomUUID() },body:JSON.stringify(body()) })));
    assert.deepEqual(simultaneous.map(response => response.status).sort(),[202,429]);
    const pending = (await simultaneous.find(response => response.status === 202)!.json() as { intent: LiveIntent }).intent;
    await request('/order-intents/' + pending.id + '/cancel','POST');
    await policy(true,{ maxPending: 2, quoteLimits: [{ quoteCurrency:'USD',perOrderNotional:'20',rolling24hNotional:'25' }] });
    const rolling = await Promise.all([1,2].map(() => fetch(url + '/api/v1/order-intents',{ method:'POST',headers:{ ...headers,'Idempotency-Key':randomUUID() },body:JSON.stringify(body()) })));
    assert.deepEqual(rolling.map(response => response.status).sort(),[202,422]);
    const rollingPending = (await rolling.find(response => response.status === 202)!.json() as { intent: LiveIntent }).intent; await request('/order-intents/' + rollingPending.id + '/cancel','POST');
    await policy(true);

    // Drop the actual claim HTTP response after the transaction commits. The client has no
    // local lease; bound control recovers the original, and never invokes submit for this row.
    const lost = await create(); let drop = true; let originalLease: ExecutorLease | null = null;
    const lossyApi = new FinanceClient({ url, token, fetch: async (input, init) => {
      const response = await fetch(input,init);
      if (drop && String(input).endsWith('/claim') && response.ok) { drop = false; const payload = await response.json() as ExecutorClaim; originalLease = payload.claim; throw new Error('Explicit smoke: response lost after durable claim'); }
      return response;
    } });
    const lostPath = join(directory,'lost.json');
    client = new ExecutorClient({ api: lossyApi, executorId: executor.id, driver:process.execPath,driverArgs:[driver,'--state',lostPath,'--mode','filled','--price','10'],statePath:join(directory,'lost.sqlite') });
    await assert.rejects(client.cycle(),/response lost/); assert.ok(originalLease); await client.close(); client = null;
    advanceClock(fixture.clock() + 30001); refresh(); await idle(); assert.equal((await get(lost.id)).state,'unknown');
    await restart(); await idle(); assert.equal((await get(lost.id)).state,'unknown');
    const control = await request<ExecutorControl>('/executors/' + executor.id + '/control','GET',undefined,bound); assert.equal(control.orders[0].leaseToken,(originalLease as ExecutorLease).leaseToken); assert.equal(control.orders[0].clientOrderId,lost.id);
    const noReclaim = await request<ExecutorClaim>('/executors/' + executor.id + '/claim','POST',undefined,bound); assert.equal(noReclaim.claim,null);
    client = new ExecutorClient({ api, executorId:executor.id,driver:process.execPath,driverArgs:[driver,'--state',lostPath,'--mode','filled','--price','10'],statePath:join(directory,'lost.sqlite') });
    const stillAmbiguous = await client.cycle(); assert.equal(stillAmbiguous.state,'unknown'); assert.equal(stillAmbiguous.unresolved,true); assert.equal((await get(lost.id)).risk.pendingCapacity,true);
    // A 30-second lease timeout is NOT permission to free ambiguous risk: a previously
    // dispatched RPC may still complete. Require original intent expiry plus absence proof.
    advanceClock(fixture.clock() + 30001); refresh(); await idle();
    const reconciled = await client.cycle(); assert.equal(reconciled.intentId,lost.id); assert.equal(reconciled.state,'expired'); assert.equal(reconciled.unresolved,false);
    const lostRecording = await recordings(lostPath); assert.equal(lostRecording.submissions.length,0); assert.ok(lostRecording.commands.every(command => command.command === 'status' && command.stage === 'reconcile'));
    await client.close(); client = null;

    // A driver may have accepted an order although its submit response was lost.
    // Status uses the same stable ID and resolves the actual recorded fill, not a retry.
    const ambiguousPath = join(directory,'ambiguous.json'); const ambiguous = await create();
    client = new ExecutorClient({ api,executorId:executor.id,driver:process.execPath,driverArgs:[driver,'--state',ambiguousPath,'--mode','ambiguous','--price','10'],statePath:join(directory,'ambiguous.sqlite') });
    const uncertain = await client.cycle(); assert.equal(uncertain.state,'unknown'); assert.equal(uncertain.unresolved,true); await client.close(); client = null;
    await restart(); await idle(); assert.equal((await get(ambiguous.id)).state,'unknown');
    client = new ExecutorClient({ api,executorId:executor.id,driver:process.execPath,driverArgs:[driver,'--state',ambiguousPath,'--mode','ambiguous','--price','10'],statePath:join(directory,'ambiguous.sqlite') });
    const found = await client.cycle(); assert.equal(found.state,'filled'); assert.equal(found.unresolved,false); assert.equal((await recordings(ambiguousPath)).submissions.length,1);
    await client.close(); client = null;

    // ACK is accepted externally, not filled, and does not time out with its submission lease.
    await policy(true,{ maxPending:2 });
    const ackPath = join(directory,'ack.json'); const accepted = await create();
    client = new ExecutorClient({ api,executorId:executor.id,driver:process.execPath,driverArgs:[driver,'--state',ackPath,'--mode','acknowledged','--price','10'],statePath:join(directory,'ack.sqlite') });
    assert.equal((await client.cycle()).state,'acknowledged'); const beforeKill = await get(accepted.id); assert.equal(beforeKill.filledQuantity,'0');
    const unsubmitted = await create(); await policy(false);
    assert.equal((await get(unsubmitted.id)).state,'cancelled'); const awaitingCancel = await get(accepted.id); assert.equal(awaitingCancel.state,'acknowledged'); assert.equal(awaitingCancel.cancelRequested,true);
    advanceClock(fixture.clock() + 60001); await idle(); assert.equal((await get(accepted.id)).state,'acknowledged');
    assert.equal((await client.cycle()).state,'cancelled'); assert.equal((await get(accepted.id)).state,'cancelled');
    assert.ok((await recordings(ackPath)).commands.some(command => command.command === 'cancel')); await client.close(); client = null;

    // Executor binding is still enforced for a valid original lease held by another key.
    const foreignExecutor = (await request<{ executor:ExecutorRecord }>('/executors','POST',{ name:'Foreign scoped recorder',enabled:true })).executor;
    const foreignToken = (await request<{ token:string }>('/api-keys','POST',{ name:'Foreign bound key',scopes:['executor:claim','executor:report'],executorId:foreignExecutor.id })).token;
    const foreign = await fetch(url + '/api/v1/order-intents/' + intent.id + '/reports',{ method:'POST',headers:{ authorization:'Bearer ' + foreignToken,'Content-Type':'application/json' },body:stored.body_json }); assert.equal(foreign.status,403);

    // An armed fixed alert continues to execute while only notifications are paused.
    refresh(); await policy(true); await request('/integrations/notifications','PUT',{ paused:true });
    const tested = (await request<{ event:AlertEvent }>('/alerts/' + alert.id + '/test','POST')).event; await idle(); assert.equal(tested.kind,'test'); assert.equal(tested.liveAction,undefined);
    advanceClock(fixture.clock() + 1000); refresh('12'); await idle();
    const signals = (await request<{ events:AlertEvent[] }>('/alert-events?alertId=' + alert.id)).events.filter(event => event.kind === 'signal');
    assert.equal(signals.length,1); assert.equal(signals[0].liveAction?.state,'created');
    const signalIntent = await get(signals[0].liveAction!.intentId!); assert.equal(signalIntent.quantity,'1'); assert.equal(signalIntent.sourceEventId,signals[0].eventId); assert.equal((await request<{ alert:AlertDefinition }>('/alerts/' + alert.id)).alert.enabled,false);
    await request('/order-intents/' + signalIntent.id + '/cancel','POST'); await request('/alerts/' + alert.id,'DELETE');

    // Run actual isolated Pine alert text containing order-looking JSON. The payload is
    // display-only: the separately configured fixed action still buys exactly one unit.
    const jsonMessage = '{"quantity":"999","side":"sell","type":"market"}';
    const saved = await request<{ revision:ScriptRevision }>('/scripts','POST',{ name:'Recording smoke JSON-looking Pine text is not an order',source:`//@version=6\nindicator("Display text is not execution authority")\nalert('${jsonMessage}', alert.freq_all)`,inputs:{},props:{} });
    const base = Math.ceil(fixture.clock() / 60000) * 60000;
    const bar = (time:number): Bar => ({ time,open:12,high:12,low:12,close:12,volume:1 });
    const series = fixture.series.get('1') ?? [];
    for (let time = series.at(-1)?.time ?? base - 60000; time <= base; time += 60000) {
      if (!series.some(item => item.time === time)) series.push(bar(time));
    }
    fixture.series.set('1',series); advanceClock(base); refresh('12'); await idle();
    const pineAlert = (await request<{ alert:AlertDefinition }>('/alerts','POST',{ ...alertBody,name:'Pine JSON text cannot replace fixed quantity',mode:'bar-close',condition:{ kind:'pine',eventType:'alert' },scriptRevisionId:saved.revision.id })).alert; await idle();
    series.push(bar(base + 60000)); advanceClock(base + 60000); refresh('12');
    fixture.emit('1',{ kind:'close',bar:bar(base),receivedAt:fixture.clock() }); await idle();
    const pineSignals = (await request<{ events:AlertEvent[] }>('/alert-events?alertId=' + pineAlert.id)).events.filter(event => event.kind === 'signal');
    assert.equal(pineSignals.length,1); assert.equal(pineSignals[0].message,jsonMessage); assert.equal(pineSignals[0].liveAction?.state,'created');
    const fixedIntent = await get(pineSignals[0].liveAction!.intentId!); assert.equal(fixedIntent.quantity,'1'); assert.equal(fixedIntent.side,'buy');
    await request('/order-intents/' + fixedIntent.id + '/cancel','POST'); await request('/alerts/' + pineAlert.id,'DELETE');
    await request('/integrations/notifications','PUT',{ paused:false }); await policy(false);
    const usage = (await request<{ usage:RiskUsage[] }>('/execution-risk')).usage; assert.equal(usage.reduce((sum,value) => sum + value.pendingIntents,0),0);
    console.log(`executor: LOCAL RECORDING DRIVER ONLY, NO VENUE/MONEY; disabled zero subprocess submissions; bound real Node/SQLite client buy1 protected cap10.1/fill10 once + report dedup; quantity11/precision/stale/expiry/CSV/replay/backtest/source rejected; concurrent pending/rolling atomic; dropped committed claim ${lost.id} unknown/restart original-token control, reconcile-only absence resolves expired with zero redispatch; ambiguous driver response resolves actual recorded fill with one submit; kill ACK remains accepted until recorded cancel; fresh once alert creates fixed quantity1 while notifications paused, test never executes; real pinned Pine JSON-looking sell999 text still fixed buy1; foreign executor denied. Real operator driver and sandbox credentials remain required for venue acceptance.`);
  } finally { await client?.close(); await rm(directory,{ recursive:true,force:true }); }
}
