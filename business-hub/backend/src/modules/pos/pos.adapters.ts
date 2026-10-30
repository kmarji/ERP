import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface TerminalResult {
  status: 'AUTHORIZED' | 'DECLINED';
  reference: string;
  reason?: string;
}

// Card-terminal integration point. Real providers are added only once terminal support is confirmed (brief s7, s17.2).
export abstract class PosTerminalAdapter {
  abstract authorize(input: { amount: string; reference?: string; method: 'CARD' | 'DIGITAL' }): Promise<TerminalResult>;
  abstract capture(reference: string): Promise<{ status: 'CAPTURED' | 'FAILED' }>;
  abstract refund(reference: string, amount: string): Promise<{ status: 'REFUNDED' | 'FAILED'; reference: string }>;
}

// Stub = manual tender entry: the cashier keys in the slip reference. A reference starting with DECLINE simulates a decline.
@Injectable()
export class StubPosTerminal extends PosTerminalAdapter {
  async authorize(input: { amount: string; reference?: string }): Promise<TerminalResult> {
    const reference = input.reference?.trim() || `MANUAL-${randomUUID().slice(0, 8).toUpperCase()}`;
    if (reference.toUpperCase().startsWith('DECLINE')) return { status: 'DECLINED', reference, reason: 'Declined by issuer (simulated)' };
    return { status: 'AUTHORIZED', reference };
  }

  async capture() {
    return { status: 'CAPTURED' as const };
  }

  async refund(reference: string) {
    return { status: 'REFUNDED' as const, reference: `${reference}-R` };
  }
}
