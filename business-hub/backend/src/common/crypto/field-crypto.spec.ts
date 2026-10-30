import { ConfigService } from '@nestjs/config';
import { FieldCrypto } from './field-crypto';

const make = (env: Record<string, string>) => new FieldCrypto(new ConfigService(env));
const key = (b: number) => Buffer.alloc(32, b).toString('base64');

describe('FieldCrypto', () => {
  it('round-trips and never leaks the plaintext', () => {
    const c = make({ DATA_ENCRYPTION_KEY: key(1) });
    const enc = c.encrypt({ nationalId: '9871234567' });
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('9871234567');
    expect(c.decrypt(enc)).toEqual({ nationalId: '9871234567' });
    expect(c.encrypt('x')).not.toBe(c.encrypt('x')); // random IV
  });

  it('detects tampering and a wrong key', () => {
    const c = make({ DATA_ENCRYPTION_KEY: key(1) });
    const enc = c.encrypt({ a: 1 });
    const bad = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => c.decrypt(bad)).toThrow();
    expect(() => make({ DATA_ENCRYPTION_KEY: key(2) }).decrypt(enc)).toThrow();
  });

  it('requires a key in production and derives one in development', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // ConfigService reads process.env first
    try {
      expect(() => make({ JWT_SECRET: 's' })).toThrow(/required/);
    } finally {
      process.env.NODE_ENV = prev;
    }
    const d = make({ JWT_SECRET: 'dev-secret' });
    expect(d.decrypt(d.encrypt([1, 2]))).toEqual([1, 2]);
    expect(() => make({ DATA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});
