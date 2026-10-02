import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentContext, AgentDraft, AgentEvent, AgentSessionView, AgentStatus, AppliedAgentDraft, BacktestJob, BarPage, ProviderId } from '../../packages/contracts/src/index.js';
import { nextBucket } from '../../packages/domain/src/market.js';

export type AgentIntegrationApi = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

/** No protocol peer/canned answer. Requires the application's real selected model and explicit operator Apply consent. */
export async function runConfiguredAgentScenario(url: string, api: AgentIntegrationApi, headers: Record<string, string>): Promise<void> {
  const status = await api<AgentStatus>('/agent/status');
  if (!status.configured || !status.available) throw new Error('Configure a real supported provider/model and credential or local endpoint through Settings → Pi. ' + (status.reason ?? 'No configured model is available.'));
  if (process.env.PINETERM_SMOKE_AGENT_APPLY !== 'true') throw new Error('Set PINETERM_SMOKE_AGENT_APPLY=true to explicitly authorize applying the validated model draft as a NEW script and simulating it. Existing scripts/alerts/live policy are never changed.');
  const provider = process.env.PINETERM_SMOKE_AGENT_PROVIDER ?? 'coinbase';
  if (!['coinbase', 'binance', 'csv'].includes(provider)) throw new Error('Select an explicit PineTerm provider for agent acceptance.');
  const symbol = process.env.PINETERM_SMOKE_AGENT_SYMBOL ?? (provider === 'binance' ? 'BTCUSDT' : 'BTC-USD');
  const context: AgentContext = { market: { provider: provider as ProviderId, symbol }, timeframe: process.env.PINETERM_SMOKE_AGENT_TIMEFRAME ?? '1', ...(process.env.PINETERM_SMOKE_AGENT_SCRIPT_REVISION_ID ? { scriptRevisionId: process.env.PINETERM_SMOKE_AGENT_SCRIPT_REVISION_ID } : {}), ...(process.env.PINETERM_SMOKE_AGENT_PAPER_ACCOUNT_ID ? { paperAccountId: process.env.PINETERM_SMOKE_AGENT_PAPER_ACCOUNT_ID } : {}) };
  const { session } = await api<{ session: AgentSessionView }>('/agent/sessions', 'POST', { title: 'Operator-authorized real model analysis/Pine acceptance' });
  const streamStop = new AbortController();
  const stream = await fetch(new URL(`/api/v1/agent/sessions/${session.id}/events`, url), { headers: { ...headers, Accept: 'text/event-stream' }, signal: AbortSignal.any([streamStop.signal, AbortSignal.timeout(150000)]), redirect: 'error' });
  assert.equal(stream.status, 200, 'Authenticated agent event stream unavailable');
  const reader = stream.body?.getReader(); assert.ok(reader, 'No real SSE body returned');
  const events: AgentEvent[] = []; const settled = Promise.withResolvers<AgentEvent & { type: 'settled' }>();
  let turnId: string | null = null; let bytes = 0;
  const consuming = (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) throw new Error('Agent event stream ended before the turn settled.');
      bytes += chunk.value.byteLength; if (bytes > 16 * 1024 * 1024) throw new Error('Agent acceptance SSE exceeded 16 MiB.');
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as AgentEvent; events.push(event);
        if (event.type === 'settled' && (turnId === null || event.turnId === turnId)) settled.resolve(event);
      }
    }
  })().catch(error => { if (!streamStop.signal.aborted) settled.reject(error); });
  try {
    const accepted = await api<{ turnId: string }>(`/agent/sessions/${session.id}/messages`, 'POST', { text: 'Analyze this explicitly selected chart using actual get_market_bars and get_quote data and cite provider, symbol, timeframe, asOf and freshness. Then propose an original Pine v6 EMA(9)/EMA(21) crossover strategy with explicit instrument quote currency, initial capital 10000, fixed quantity 1, commission percent 0.1, slippage 0 and next-bar order processing. Use propose_script and isolated validation. Explain that simulations differ from TradingView and no profitability/safety is guaranteed. Do not trade, arm alerts or change execution policy.', context });
    turnId = accepted.turnId;
    const completion = await settled.promise;
    assert.equal(completion.turnId, turnId);
    assert.equal(completion.state, 'completed', 'The real configured model did not complete its turn');
    const turn = events.filter(event => event.turnId === turnId);
    const text = turn.filter((event): event is AgentEvent & { type: 'text_delta' } => event.type === 'text_delta').map(event => event.text).join('');
    assert.ok(text.trim(), 'No real model text deltas observed');
    for (const tool of ['get_market_bars', 'get_quote', 'propose_script']) assert.ok(turn.some(event => event.type === 'tool_end' && event.tool === tool), `No actual ${tool} completion observed`);
    const proposal = turn.findLast((event): event is AgentEvent & { type: 'draft' } => event.type === 'draft');
    assert.ok(proposal, 'No server-owned Pine proposal observed');
    const { draft } = await api<{ draft: AgentDraft }>(`/agent/drafts/${proposal.draftId}`);
    assert.equal(draft.appliedRevisionId, null, 'Model proposal must not apply itself');
    assert.equal(draft.validation?.valid, true, JSON.stringify(draft.diagnostics));
    assert.equal(draft.validation.declarationType, 'strategy', 'Model must propose an actual Pine strategy');
    const applied = await api<AppliedAgentDraft>(`/agent/drafts/${draft.id}/apply`, 'POST', { revision: draft.revision, mode: 'new', name: draft.name });
    const query = new URLSearchParams({ ...context.market, timeframe: context.timeframe, limit: '501' });
    const page = await api<BarPage>('/bars?' + query);
    if (page.providerError || page.status === 'stale') throw new Error('Agent draft applied, but complete confirmed history is unavailable for the requested simulation.');
    // Do not infer confirmation from wall time alone: exclude the provider's newest tail as well.
    const closed = page.bars.filter((bar, index) => (context.market.provider === 'csv' || index < page.bars.length - 1) && nextBucket(bar.time, context.timeframe) <= page.asOf);
    assert.ok(closed.length, 'No confirmed raw simulation window available');
    const { jobId } = await api<{ jobId: string }>('/backtests', 'POST', { scriptRevisionId: applied.revision.id, market: context.market, timeframe: context.timeframe, from: closed[0]!.time, to: nextBucket(closed.at(-1)!.time, context.timeframe), inputs: draft.inputs, props: draft.props });
    let job: BacktestJob; const deadline = Date.now() + 90000;
    do { await delay(500); job = (await api<{ job: BacktestJob }>(`/backtests/${jobId}`)).job; } while (['queued', 'running'].includes(job.state) && Date.now() < deadline);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.diagnostic));
    assert.ok(job.result?.strategy && job.provenance, 'No immutable real runner simulation/provenance result');
    console.log(`agent: real ${status.provider}/${status.model} streamed analysis, actual bars/quote provenance, validated draft ${draft.id}, explicit NEW Apply ${applied.revision.id}, real PineTS simulation ${jobId}; final equity ${job.result.strategy.finalEquity} ${job.result.strategy.currency}. No live order or profitability claim.`);
    if (completion.usage) console.log('agent: SDK-supplied usage', JSON.stringify(completion.usage));
  } finally {
    streamStop.abort(); await reader.cancel().catch(() => {}); await consuming;
    await api(`/agent/sessions/${session.id}/cancel`, 'POST');
  }
}
