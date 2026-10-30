import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'v1:';

// AES-256-GCM field encryption for personal data (national id, date of birth, bank account).
// ponytail: single static key; add key ids + rotation (re-encrypt job) when a KMS is introduced.
@Injectable()
export class FieldCrypto {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('DATA_ENCRYPTION_KEY');
    if (raw) {
      const k = Buffer.from(raw, 'base64');
      if (k.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
      this.key = k;
    } else if (config.get('NODE_ENV') === 'production') {
      throw new Error('DATA_ENCRYPTION_KEY is required in production');
    } else {
      new Logger('FieldCrypto').warn('DATA_ENCRYPTION_KEY not set: deriving a development key from JWT_SECRET');
      this.key = scryptSync(config.getOrThrow<string>('JWT_SECRET'), 'business-hub-field-crypto', 32);
    }
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  decrypt<T = unknown>(payload: string): T {
    if (!payload.startsWith(PREFIX)) throw new Error('Unsupported ciphertext format');
    const buf = Buffer.from(payload.slice(PREFIX.length), 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')) as T;
  }
}

@Global()
@Module({ providers: [FieldCrypto], exports: [FieldCrypto] })
export class FieldCryptoModule {}
