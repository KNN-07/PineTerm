import { createHash } from 'node:crypto';
import type { Bar, DatasetImport } from '../../../../packages/contracts/src/market.js';
import { financialDecimal } from '../../../../packages/domain/src/index.js';
import { barIssue, bucketStart, isTimeframe } from '../../../../packages/domain/src/market.js';
import { ApiError } from '../errors.js';

export const MAX_DATASET_BYTES = 10 * 1024 * 1024;
export const DATASET_FIELDS = ['name', 'baseCurrency', 'quoteCurrency', 'timeframe', 'tickSize', 'quantityStep'] as const;

export function parseDataset(meta: DatasetImport, csv: string): { meta: DatasetImport; bars: Bar[]; sourceHash: string } {
  if (!meta || typeof meta !== 'object' || Object.keys(meta).some((key) => !(DATASET_FIELDS as readonly string[]).includes(key))) {
    throw new ApiError(400, 'INVALID_DATASET_METADATA', 'Provide only the six documented dataset metadata fields.');
  }
  for (const field of DATASET_FIELDS) {
    if (typeof meta[field] !== 'string' || !meta[field].length) throw new ApiError(400, 'INVALID_DATASET_METADATA', `Missing or invalid ${field}.`);
  }
  if (meta.name.trim() !== meta.name || meta.name.length > 100 || /[\u0000-\u001f]/.test(meta.name)) throw new ApiError(400, 'INVALID_DATASET_METADATA', 'Name must be 1–100 printable characters without surrounding whitespace.');
  for (const field of ['baseCurrency', 'quoteCurrency'] as const) {
    if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(meta[field])) throw new ApiError(400, 'INVALID_DATASET_METADATA', `${field} must be an explicit uppercase currency identifier.`);
  }
  if (!isTimeframe(meta.timeframe)) throw new ApiError(422, 'UNSUPPORTED_TIMEFRAME', 'Select a supported dataset timeframe.');
  for (const field of ['tickSize', 'quantityStep'] as const) {
    try {
      if (meta[field].length > 100 || !financialDecimal(meta[field]).isPositive()) throw new Error('not positive');
    } catch {
      throw new ApiError(400, 'INVALID_DATASET_METADATA', `${field} must be a positive canonical decimal string.`);
    }
  }
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > MAX_DATASET_BYTES) throw new ApiError(400, 'DATASET_TOO_LARGE', 'CSV files must not exceed 10 MiB.');
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== 'time,open,high,low,close,volume') throw new ApiError(400, 'INVALID_CSV_HEADER', 'CSV header must be exactly time,open,high,low,close,volume.');
  const bars: Bar[] = [];
  const seen = new Map<number, number>();
  const errors: { row: number; message: string }[] = [];
  for (let index = 1; index < lines.length; index++) {
    const row = index + 1;
    const fields = lines[index].split(',').map((field) => /^"[^"\r\n]*"$/.test(field) ? field.slice(1, -1) : field);
    if (fields.length !== 6 || fields.some((field) => !field.length || field.trim() !== field || field.includes('"'))) {
      errors.push({ row, message: 'Expected exactly six nonempty CSV fields.' });
    } else {
      const rawTime = fields[0];
      let time = Number.NaN;
      if (/^\d{12,16}$/.test(rawTime)) {
        time = Number(rawTime);
      } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(rawTime)) {
        time = Date.parse(rawTime);
        const normalized = rawTime.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
        if (!Number.isFinite(time) || new Date(time).toISOString() !== normalized) time = Number.NaN;
      }
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
      const values = fields.slice(1).map((field) => numeric.test(field) ? Number(field) : Number.NaN);
      const bar: Bar = { time, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] };
      const issue = barIssue(bar);
      if (issue) errors.push({ row, message: issue });
      else if (bucketStart(time, meta.timeframe) !== time) errors.push({ row, message: 'Timestamp must be aligned to the declared UTC timeframe bar open.' });
      else if (seen.has(time)) errors.push({ row, message: `Duplicate timestamp also appears at row ${seen.get(time)}.` });
      else {
        seen.set(time, row);
        bars.push(bar);
      }
    }
    if (errors.length >= 50) break;
  }
  if (errors.length) throw new ApiError(400, 'INVALID_DATASET_ROWS', 'CSV import rejected; no rows were saved. Use UTC ISO-8601 or epoch milliseconds (not seconds).', { rows: errors });
  if (!bars.length) throw new ApiError(400, 'EMPTY_DATASET', 'Import at least one valid OHLCV row.');
  bars.sort((left, right) => left.time - right.time);
  return { meta: { ...meta }, bars, sourceHash: createHash('sha256').update(csv).digest('hex') };
}
