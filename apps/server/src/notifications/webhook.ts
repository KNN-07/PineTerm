import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Config } from '../config.js';
import { ApiError } from '../errors.js';

export interface ResolvedAddress { address: string; family: number }
export type WebhookResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface DeliveryResult { delivered: boolean; status: number | null; error: string | null; retryAfterMs?: number; terminal?: boolean }
const resolveAddresses: WebhookResolver = hostname => lookup(hostname, { all: true, verbatim: true });
const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_WEBHOOK_BYTES = 256 * 1024;

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}
function ipv6Number(address: string): bigint {
  let input = address.toLowerCase();
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = ipv4Number(input.slice(lastColon + 1));
    input = input.slice(0, lastColon) + ':' + Math.floor(ipv4 / 65536).toString(16) + ':' + (ipv4 % 65536).toString(16);
  }
  const halves = input.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  return parts.reduce((value, part) => (value << 16n) | BigInt('0x' + part), 0n);
}
function inV4Range(value: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(ipv4Number(base) / size);
}
function inV6Range(value: bigint, base: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === ipv6Number(base) >> shift;
}
/** Only globally routable addresses. IPv4-mapped IPv6 is checked as IPv4, not trusted as a separate family. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const forbidden: Array<[string, number]> = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
      ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
      ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !forbidden.some(([base, bits]) => inV4Range(value, base, bits));
  }
  if (family !== 6) return false;
  const value = ipv6Number(address);
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return isPublicAddress([v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.'));
  }
  return inV6Range(value, '2000::', 3) && ![
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ].some(([base, bits]) => inV6Range(value, String(base), Number(bits)));
}

export function parseWebhookUrl(value: string, config: Pick<Config, 'mode' | 'webhookLocalHosts'>): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, 'INVALID_WEBHOOK_URL', 'Provide an absolute HTTPS webhook URL.'); }
  const local = config.mode === 'development' && config.webhookLocalHosts.includes(url.hostname);
  if (url.username || url.password || url.hash || value.includes('#') || (!local && url.protocol !== 'https:') || !['https:', 'http:'].includes(url.protocol)) {
    throw new ApiError(400, 'INVALID_WEBHOOK_URL', 'Webhooks require HTTPS without credentials or fragments; HTTP is allowed only for an exact development host.');
  }
  if (value.length > 2048) throw new ApiError(400, 'INVALID_WEBHOOK_URL', 'Webhook URL is limited to 2048 characters.');
  return url;
}
async function boundedResolve(hostname: string, resolver: WebhookResolver, signal: AbortSignal): Promise<ResolvedAddress[]> {
  if (signal.aborted) throw new ApiError(503, 'DELIVERY_ABORTED', 'Delivery was interrupted.');
  const { promise, resolve, reject } = Promise.withResolvers<ResolvedAddress[]>();
    const timer = setTimeout(() => finish(new ApiError(503, 'WEBHOOK_DNS_UNAVAILABLE', 'Webhook DNS resolution timed out.')), 2000);
    const abort = () => finish(new ApiError(503, 'DELIVERY_ABORTED', 'Delivery was interrupted.'));
    function finish(error?: Error, addresses?: ResolvedAddress[]) {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(addresses!);
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => resolver(hostname)).then(addresses => finish(undefined, addresses), () => finish(new ApiError(503, 'WEBHOOK_DNS_UNAVAILABLE', 'Webhook hostname could not be resolved.')));
  return promise;
}
export async function resolveWebhook(url: URL, config: Pick<Config, 'mode' | 'webhookLocalHosts'>, signal: AbortSignal, resolver: WebhookResolver = resolveAddresses): Promise<ResolvedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await boundedResolve(hostname, resolver, signal);
  const local = config.mode === 'development' && config.webhookLocalHosts.includes(url.hostname);
  if (!addresses.length || addresses.some(entry => !isIP(entry.address) || isIP(entry.address) !== entry.family || (!local && !isPublicAddress(entry.address)))) {
    throw new ApiError(422, 'UNSAFE_WEBHOOK_ADDRESS', 'Webhook DNS must resolve exclusively to public addresses. Private, loopback, reserved and metadata destinations are blocked.');
  }
  return addresses[0];
}
export function retryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2_147_000_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 2_147_000_000) : undefined;
}

/** No redirects or unvalidated DNS lookup: each request gets one fresh, validated, pinned address. */
export async function deliverWebhook(value: string, secret: string, body: Buffer, timestamp: string, config: Pick<Config, 'mode' | 'webhookLocalHosts'>, signal: AbortSignal, resolver?: WebhookResolver): Promise<DeliveryResult> {
  if (body.length > MAX_WEBHOOK_BYTES) return { delivered: false, status: null, error: 'Webhook payload exceeds 256 KiB.', terminal: true };
  signal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    const url = parseWebhookUrl(value, config);
    const address = await resolveWebhook(url, config, signal, resolver);
    if (signal.aborted) return { delivered: false, status: null, error: 'Delivery was interrupted.' };
    const signature = createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
    const { promise, resolve } = Promise.withResolvers<DeliveryResult>();
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = transport(url, {
        method: 'POST', agent: false, signal,
        // The URL still supplies hostname, SNI, Host and certificate validation. Only DNS is pinned.
        lookup: (_hostname, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
        headers: { 'content-type': 'application/json', 'content-length': body.length, 'X-PineTerm-Timestamp': timestamp, 'X-PineTerm-Signature': `sha256=${signature}` },
      }, response => {
        let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error('Response too large.')); });
        response.on('error', () => complete({ delivered: false, status: response.statusCode ?? null, error: 'Webhook response was interrupted or exceeded 64 KiB.' }));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          complete({ delivered: status >= 200 && status < 300, status, error: status >= 200 && status < 300 ? null : status >= 300 && status < 400 ? 'Webhook redirects are not permitted.' : `Webhook returned HTTP ${status}.`, terminal: status >= 300 && status < 500 && status !== 429, retryAfterMs: status === 429 ? retryAfterMs(response.headers['retry-after']) : undefined });
        });
      });
      const timer = setTimeout(() => request.destroy(new Error('Delivery timed out.')), 10_000);
      function complete(result: DeliveryResult) { clearTimeout(timer); resolve(result); }
      request.on('error', () => complete({ delivered: false, status: null, error: signal.aborted ? 'Delivery was interrupted.' : 'Webhook connection failed or timed out.' }));
      request.end(body);
    return await promise;
  } catch (error) {
    return { delivered: false, status: null, error: error instanceof ApiError ? error.message : 'Webhook delivery could not be prepared.', terminal: error instanceof ApiError && error.statusCode < 500 };
  }
}
