import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  adminPassword: string;
  sessionSecret: string;
  secretKey: Buffer;
  dataDir: string;
  host: string;
  port: number;
  publicOrigin: string;
  mode: 'development' | 'production';
  webDistDir: string;
  sourceRevision: string | null;
  sourceUrl: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['PINETERM_ADMIN_PASSWORD', 'PINETERM_SESSION_SECRET', 'PINETERM_SECRET_KEY']
    .filter((name) => !env[name]);
  if (missing.length) {
    throw new ConfigurationError(`Missing required configuration: ${missing.join(', ')}. Set these in .env; see .env.example.`);
  }
  const adminPassword = env.PINETERM_ADMIN_PASSWORD!;
  const sessionSecret = env.PINETERM_SESSION_SECRET!;
  if (Buffer.byteLength(adminPassword) > 1024) {
    throw new ConfigurationError('PINETERM_ADMIN_PASSWORD must be at most 1024 UTF-8 bytes.');
  }
  if (Buffer.byteLength(sessionSecret) < 32) {
    throw new ConfigurationError('PINETERM_SESSION_SECRET must contain at least 32 random bytes. Generate one with crypto.randomBytes(48).toString("base64").');
  }
  const encodedKey = env.PINETERM_SECRET_KEY!;
  const secretKey = Buffer.from(encodedKey, 'base64');
  if (secretKey.length !== 32 || secretKey.toString('base64') !== encodedKey) {
    throw new ConfigurationError('PINETERM_SECRET_KEY must be a canonical base64-encoded 32-byte AES-GCM key. Generate one with crypto.randomBytes(32).toString("base64").');
  }
  const host = env.PINETERM_HOST ?? '127.0.0.1';
  if (!host.trim() || host !== host.trim()) {
    throw new ConfigurationError('PINETERM_HOST must be a nonempty hostname or IP address without surrounding whitespace.');
  }
  const rawPort = env.PINETERM_PORT ?? '3000';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PINETERM_PORT must be an integer between 1 and 65535.');
  }
  const publicOrigin = env.PINETERM_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000';
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new ConfigurationError('PINETERM_PUBLIC_ORIGIN must be an absolute HTTP(S) origin.');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== publicOrigin || origin.username || origin.password) {
    throw new ConfigurationError('PINETERM_PUBLIC_ORIGIN must be exactly an HTTP(S) origin, without path, trailing slash, credentials, query or fragment.');
  }
  const sourceRevision = env.PINETERM_SOURCE_REVISION || null;
  if (sourceRevision !== null && !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new ConfigurationError('PINETERM_SOURCE_REVISION must be a full lowercase 40-character Git commit hash when supplied.');
  }
  const dataDir = env.PINETERM_DATA_DIR ?? './data';
  if (!dataDir.trim()) {
    throw new ConfigurationError('PINETERM_DATA_DIR must be a nonempty directory path.');
  }
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';
  return {
    adminPassword,
    sessionSecret,
    secretKey,
    dataDir: resolve(dataDir),
    host,
    port,
    publicOrigin,
    mode,
    webDistDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    sourceRevision,
    sourceUrl: sourceRevision
      ? `https://github.com/KNN-07/PineTerm/tree/${sourceRevision}`
      : 'https://github.com/KNN-07/PineTerm',
  };
}
