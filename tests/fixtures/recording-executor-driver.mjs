#!/usr/bin/env node
/** LOCAL TEST FIXTURE ONLY. Records protocol requests; does not contact any venue,
 * accept exchange credentials, or prove real-market/sandbox execution. Selection is explicit. */
import { open, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Decimal } from 'decimal.js';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const command = args.pop();
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!args[index]?.startsWith('--') || args[index + 1] === undefined) process.exit(64);
  options[args[index].slice(2)] = args[index + 1];
}
if (!['submit', 'status', 'cancel'].includes(command) || !options.state || !isAbsolute(options.state)) process.exit(64);
const mode = options.mode ?? 'filled';
if (!['filled', 'acknowledged', 'hold', 'ambiguous'].includes(mode)) process.exit(64);
const price = options.price ?? '10';
const quoteAge = Number(options['quote-age-ms'] ?? '0');
const preflightDelay = Number(options['preflight-delay-ms'] ?? '0');
const submitDelay = Number(options['submit-delay-ms'] ?? '0');
if (![quoteAge, preflightDelay, submitDelay].every(value => Number.isInteger(value) && value >= 0 && value <= 120000)) process.exit(64);
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) process.exit(65); }
const request = JSON.parse(input);
const started = performance.now();
if (request.protocol !== 1 || request.command !== command || request.clientOrderId !== request.intent?.id || !Number.isSafeInteger(request.now)) process.exit(65);
await mkdir(dirname(options.state), { recursive: true, mode: 0o700 });
const lockPath = options.state + '.lock';
let lock;
for (let attempt = 0; attempt < 100; attempt++) {
  try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); break; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const pid = Number(await readFile(lockPath, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') await unlink(lockPath); else throw probe; }
      }
    } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
    await delay(10);
  }
}
if (!lock) process.exit(75);
let reply; let ambiguous = false;
try {
  let state = { label: 'LOCAL RECORDING DRIVER; NO EXCHANGE CONNECTION', orders: {}, commands: [], submissions: [] };
  try { state = JSON.parse(await readFile(options.state, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state.commands.push({ command, stage: request.stage, clientOrderId: request.clientOrderId, now: request.now });
  let order = state.orders[request.clientOrderId];
  const quote = { market: { provider: options['quote-provider'] ?? request.intent.market.provider, symbol: options['quote-symbol'] ?? request.intent.market.symbol }, price, observedAt: request.now - quoteAge };
  if (command === 'status') {
    if (request.stage === 'preflight') await delay(preflightDelay);
    reply = order?.reply ?? { status: 'not_submitted', absenceConfirmed: options['absence-confirmed'] !== 'false', fills: [] };
    if (request.stage === 'preflight') reply = { ...reply, quote };
  } else if (command === 'cancel') {
    if (!order) reply = { status: 'not_submitted', absenceConfirmed: options['absence-confirmed'] !== 'false', fills: [] };
    else if (order.reply.status === 'filled') reply = order.reply;
    else { order.reply = { status: 'cancelled', externalOrderId: 'local-only-' + request.clientOrderId, fills: order.reply.fills }; reply = order.reply; }
  } else if (order) reply = order.reply;
  else {
    if (options['fork-marker']) {
      if (!isAbsolute(options['fork-marker'])) process.exit(64);
      // An owned descendant ignores TERM, exercising group KILL on client close/timeout.
      spawn(process.execPath, ['--input-type=module', '--eval', "import {writeFile} from 'node:fs/promises'; process.on('SIGTERM',()=>{}); setTimeout(()=>writeFile(process.argv[1],'LOCAL TEST-ONLY delayed placement'),2000);", options['fork-marker']], { stdio: 'ignore' });
      await writeFile(options['fork-marker'] + '.started', 'LOCAL TEST ONLY descendant started', { mode: 0o600 });
    }
    await delay(submitDelay);
    const now = request.now + Math.ceil(performance.now() - started);
    const deadline = Math.min(request.intent.expiresAt, request.intent.leaseExpiresAt ?? request.intent.expiresAt);
    const amount = new Decimal(request.intent.quantity), actual = new Decimal(price);
    const tick = new Decimal(request.tickSize), step = new Decimal(request.quantityStep);
    const buy = request.intent.side === 'buy';
    const cap = request.maxExecutionPrice === null ? null : new Decimal(request.maxExecutionPrice).div(tick).floor().mul(tick);
    const floor = request.minExecutionPrice === null ? null : new Decimal(request.minExecutionPrice).div(tick).ceil().mul(tick);
    const protectedMarket = request.intent.type !== 'market' || (cap && floor && (buy ? actual.lte(cap) : actual.gte(floor)));
    if (now >= deadline || !amount.gt(0) || !amount.mod(step).isZero() || !actual.mod(tick).isZero() || !protectedMarket) reply = { status: now >= deadline ? 'expired' : 'rejected', fills: [] };
    else {
      const externalOrderId = 'local-only-' + request.clientOrderId;
      const limitCrossed = request.intent.type === 'market' || (buy ? actual.lte(request.intent.limitPrice) : actual.gte(request.intent.limitPrice));
      const fill = { externalFillId: 'local-fill-' + request.clientOrderId, quantity: request.intent.quantity, price, fee: '0', currency: request.quoteCurrency, time: now };
      reply = mode === 'hold' ? { status: 'unknown', externalOrderId, fills: [] }
        : mode === 'acknowledged' || !limitCrossed ? { status: 'acknowledged', externalOrderId, fills: [] }
          : { status: 'filled', externalOrderId, fills: [fill] };
      order = { request, reply }; state.orders[request.clientOrderId] = order;
      state.submissions.push({ clientOrderId: request.clientOrderId, market: request.intent.market, side: request.intent.side, protectedCap: cap?.toFixed() ?? null, protectedFloor: floor?.toFixed() ?? null });
      ambiguous = mode === 'ambiguous';
    }
  }
  const temporary = options.state + '.' + process.pid + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, options.state);
  const directory = await open(dirname(options.state), 'r'); try { await directory.sync(); } finally { await directory.close(); }
} finally { await lock.close(); await unlink(lockPath); }
// This simulates an externally accepted outcome whose submit response was lost.
if (ambiguous) process.exit(75);
process.stdout.write(JSON.stringify({ ...reply, environment: 'recording', venue: 'local-recording-only' }) + '\n');
