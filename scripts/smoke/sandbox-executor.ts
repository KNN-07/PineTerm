import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { DriverRequest, ExecutionPolicy, ExecutorControl, Instrument, LiveIntent } from '../../packages/contracts/src/index.js';
import { FinanceClient } from '../../examples/api-client/src/index.js';
import { ExecutorClient } from '../../examples/executor-client/src/index.js';
import { executable, runDriver } from '../../examples/executor-client/src/driver.js';

export type AdminIntegrationApi = <T>(path: string, method?: string) => Promise<T>;

/** Operator-prepared sandbox intents only. Never enables policy or chooses quantity/markets on the operator's behalf. */
export async function runSandboxExecutorScenario(url: string, api: AdminIntegrationApi): Promise<void> {
  const required = ['PINETERM_SMOKE_EXECUTOR_ID', 'PINETERM_SMOKE_EXECUTOR_TOKEN', 'PINETERM_SMOKE_EXECUTOR_DRIVER', 'PINETERM_SMOKE_EXECUTOR_STATE', 'PINETERM_SMOKE_EXECUTOR_FILL_INTENT_ID', 'PINETERM_SMOKE_EXECUTOR_CANCEL_INTENT_ID'] as const;
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error('Real sandbox acceptance needs an operator executable/account and explicit prepared intent IDs. Missing: ' + missing.join(', '));
  if (process.env.PINETERM_SMOKE_EXECUTOR_SANDBOX !== 'true') throw new Error('Set PINETERM_SMOKE_EXECUTOR_SANDBOX=true only for an operator-owned exchange sandbox/testnet account. Funded-market verification is forbidden.');
  const executorId = process.env.PINETERM_SMOKE_EXECUTOR_ID!;
  const ids = [process.env.PINETERM_SMOKE_EXECUTOR_FILL_INTENT_ID!, process.env.PINETERM_SMOKE_EXECUTOR_CANCEL_INTENT_ID!];
  assert.notEqual(ids[0], ids[1], 'Prepare distinct fill and cancellation test intents');
  const driver = executable(process.env.PINETERM_SMOKE_EXECUTOR_DRIVER!);
  const parsed: unknown = JSON.parse(process.env.PINETERM_SMOKE_EXECUTOR_DRIVER_ARGS ?? '[]');
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) throw new Error('PINETERM_SMOKE_EXECUTOR_DRIVER_ARGS must be a JSON string array.');
  const args = parsed as string[];
  const { intents } = await api<{ intents: LiveIntent[] }>('/order-intents');
  const selected = ids.map(id => intents.find(intent => intent.id === id));
  if (selected.some(intent => !intent || intent.executorId !== executorId || intent.state !== 'pending')) throw new Error('Both selected intents must be fresh pending intents for this dedicated sandbox executor.');
  const fill = selected[0]!, cancel = selected[1]!;
  if (fill.type !== 'market' || cancel.type !== 'limit') throw new Error('Prepare one small market fill intent and one independently chosen non-marketable limit intent for cancellation.');
  if (intents.some(intent => intent.executorId === executorId && !['filled', 'cancelled', 'rejected', 'expired'].includes(intent.state) && !ids.includes(intent.id))) throw new Error('Use a dedicated sandbox executor with no unrelated open/unknown intents.');
  const policy = await api<ExecutionPolicy>('/execution-policy');
  if (!policy.enabled) throw new Error('The administrator must explicitly configure and enable finite sandbox handoff limits before this check; this command never arms policy.');
  const bearer = new FinanceClient({ url, token: process.env.PINETERM_SMOKE_EXECUTOR_TOKEN! });
  const control = await bearer.request<ExecutorControl>(`/executors/${executorId}/control`);
  if (!control.executorEnabled || !control.policyEnabled || control.claimsPausedReason || control.orders.length) throw new Error('Sandbox executor must be enabled and have no leased/unresolved outcomes before acceptance.');

  // Read-only driver attestation precedes any claim/submission. Local recording fixtures are explicitly ineligible.
  for (const intent of [fill, cancel]) {
    const { markets } = await api<{ markets: Instrument[] }>('/markets?' + new URLSearchParams({ provider: intent.market.provider, q: intent.market.symbol }));
    const instrument = markets.find(item => item.market.symbol === intent.market.symbol);
    if (!instrument) throw new Error('Prepared intent metadata is unavailable from its explicit venue.');
    const { reports: _reports, ...plainIntent } = intent;
    const request: DriverRequest = { protocol: 1, command: 'status', stage: 'preflight', clientOrderId: intent.id, intent: plainIntent, quoteCurrency: intent.quoteCurrency, quantityStep: instrument.quantityStep, tickSize: instrument.tickSize, minExecutionPrice: intent.minExecutionPrice, maxExecutionPrice: intent.maxExecutionPrice, now: control.serverTime, requireSandbox: true };
    const proof = await runDriver(driver, args, request, 10000, AbortSignal.timeout(10000));
    if (!['sandbox', 'testnet'].includes(proof.environment ?? '') || !proof.venue || proof.status !== 'not_submitted') throw new Error('The operator driver must attest sandbox/testnet venue and no existing selected order before any submission. A local recorder or live account is not accepted.');
  }
  const client = new ExecutorClient({ api: bearer, executorId, driver, driverArgs: args, statePath: process.env.PINETERM_SMOKE_EXECUTOR_STATE!, requireSandbox: true });
  try {
    const deadline = Date.now() + 120000;
    let filled: LiveIntent | undefined;
    let acknowledged: LiveIntent | undefined;
    while (Date.now() < deadline) {
      await client.cycle();
      filled = (await api<{ intent: LiveIntent }>(`/order-intents/${fill.id}`)).intent;
      acknowledged = (await api<{ intent: LiveIntent }>(`/order-intents/${cancel.id}`)).intent;
      if (filled.state === 'filled' && ['acknowledged', 'partially_filled'].includes(acknowledged.state)) break;
      if ([filled, acknowledged].some(intent => ['rejected', 'cancelled', 'expired', 'unknown'].includes(intent.state))) throw new Error('Sandbox driver did not produce the required fill/open-order acknowledgement. Outcome remains audited; no submission is retried.');
      await delay(1000);
    }
    assert.equal(filled?.state, 'filled', 'No externally reported sandbox fill within 120 seconds');
    assert.ok(filled.externalOrderId && filled.reports.some(report => report.fills.length > 0), 'Fill acceptance needs a venue order ID and reported execution, not a claim acknowledgement');
    assert.ok(acknowledged && ['acknowledged', 'partially_filled'].includes(acknowledged.state) && acknowledged.externalOrderId, 'Cancellation acceptance needs a separately acknowledged external order');
    const requested = (await api<{ intent: LiveIntent }>(`/order-intents/${cancel.id}/cancel`, 'POST')).intent;
    assert.equal(requested.cancelRequested, true);
    assert.notEqual(requested.state, 'cancelled', 'The server must not invent exchange cancellation before a driver report');
    let cancelled = requested;
    while (Date.now() < deadline) {
      await client.cycle();
      cancelled = (await api<{ intent: LiveIntent }>(`/order-intents/${cancel.id}`)).intent;
      if (cancelled.state === 'cancelled') break;
      if (cancelled.state === 'filled') throw new Error('The external limit order filled before cancellation; cancellation acceptance was not achieved.');
      await delay(1000);
    }
    assert.equal(cancelled.state, 'cancelled', 'No externally reported sandbox cancellation was observed');
    assert.ok(cancelled.reports.some(report => report.status === 'cancelled'), 'Cancellation needs an actual executor report');
    console.log(`executor: operator-attested sandbox/testnet actual client handoff, stable IDs ${fill.id}/${cancel.id}, venue fill, status reconciliation and reported cancellation. No funded-market acceptance claim.`);
  } finally { await client.close(); }
}
