import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function signMaterial(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('base64url');
}

/** Context binds ciphertext to its record/field, preventing a valid secret being moved to another setting. */
export class SecretStore {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretStore requires a 32-byte AES-GCM key.');
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string, context: string): string {
    if (!context) throw new Error('Encrypted secrets require a record/field context.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(`pineterm:v1:${context}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(envelope: string, context: string): string {
    const parts = envelope.split('.');
    if (!context || parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid encrypted secret envelope.');
    const fields = parts.slice(1);
    if (fields.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) throw new Error('Invalid encrypted secret encoding.');
    const [nonce, tag, ciphertext] = fields.map((part) => Buffer.from(part, 'base64url'));
    if (nonce.length !== 12 || tag.length !== 16 || fields.some((part, index) => [nonce, tag, ciphertext][index].toString('base64url') !== part)) {
      throw new Error('Invalid encrypted secret encoding.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
      decipher.setAAD(Buffer.from(`pineterm:v1:${context}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Encrypted secret could not be authenticated. Check PINETERM_SECRET_KEY and record context.');
    }
  }

  dispose(): void {
    this.#key.fill(0);
  }
}
