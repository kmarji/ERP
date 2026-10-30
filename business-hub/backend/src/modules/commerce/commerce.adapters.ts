import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------- payment gateway (online card payments)

export interface GatewayResult {
  status: 'CAPTURED' | 'DECLINED';
  reference: string;
  reason?: string;
}

// Card data never reaches this system: the customer's browser exchanges it with the gateway for a token (hosted fields),
// and only that token is sent here. Real gateways plug in once chosen (brief s7.1, s17.2).
export abstract class PaymentGatewayAdapter {
  abstract authorizeAndCapture(input: { amount: string; currency: string; orderRef: string; token: string }): Promise<GatewayResult>;
  abstract refund(reference: string, amount: string): Promise<{ status: 'REFUNDED' | 'FAILED'; reference: string }>;
}

@Injectable()
export class StubPaymentGateway extends PaymentGatewayAdapter {
  async authorizeAndCapture(input: { token: string }): Promise<GatewayResult> {
    if (input.token.toUpperCase().startsWith('DECLINE')) return { status: 'DECLINED', reference: `STUBPAY-${randomUUID().slice(0, 8)}`, reason: 'Declined (simulated)' };
    return { status: 'CAPTURED', reference: `STUBPAY-${randomUUID().slice(0, 8).toUpperCase()}` };
  }

  async refund(reference: string) {
    return { status: 'REFUNDED' as const, reference: `${reference}-R` };
  }
}

// ---------------------------------------------------------------- customer notifications

export interface CustomerMessage {
  phone?: string | null;
  email?: string | null;
  template: string;
  text: string;
  textAr?: string;
}

// SMS/WhatsApp/email provider hook. The stub only records what would have been sent.
export abstract class CustomerNotificationAdapter {
  abstract send(msg: CustomerMessage): Promise<void>;
}

@Injectable()
export class StubCustomerNotifier extends CustomerNotificationAdapter {
  private readonly log = new Logger('CustomerNotification');
  readonly sent: CustomerMessage[] = [];

  async send(msg: CustomerMessage) {
    this.sent.push(msg);
    this.log.log(`-> ${msg.phone ?? msg.email ?? 'n/a'}: ${msg.text}`);
  }
}

// ---------------------------------------------------------------- marketplaces (Talabat, Careem)

// Canonical order: whatever a marketplace sends is translated into this shape first, then into our order core.
// unitPrice is the per-unit price the customer was charged including modifiers, tax-inclusive.
export interface ExternalOrder {
  type?: 'ORDER' | 'CANCEL' | 'REFUND';
  externalId: string;
  placedAt: string;
  customer?: { name?: string; phone?: string };
  address?: { text?: string; area?: string };
  lines?: { externalItemId: string; name?: string; qty: number; unitPrice: number; modifiers?: { externalId: string; name?: string }[]; notes?: string }[];
  merchantFundedDiscount?: number; // reduces our revenue
  marketplaceFundedDiscount?: number; // reimbursed by the marketplace: informational, revenue stays gross
  deliveryFeeMerchant?: number; // only when the merchant (not the marketplace) charges and keeps the fee
  total?: number; // what the marketplace owes us for the goods, before commission
  paymentMethod?: 'ONLINE_PREPAID' | 'CASH';
  refund?: { full?: boolean; lines?: { externalItemId: string; qty: number }[]; reason?: string };
}

export interface ExternalSettlement {
  reference: string;
  settlementDate: string;
  gross: number;
  fees: number;
  net: number;
  lines: { reference: string; amount: number }[];
}

export type MarketplaceStatus = 'ACCEPTED' | 'REJECTED' | 'READY' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';

export interface MarketplaceStore {
  provider: string;
  storeRef: string;
}

// Each marketplace integration requires verified API access, merchant permissions and sandbox testing before a live
// adapter is written (brief s7.2). Operations never depend on it: every call here goes through the retrying job queue.
export abstract class AggregatorAdapter {
  abstract fetchOrders(store: MarketplaceStore, since: Date | null): Promise<ExternalOrder[]>;
  abstract respond(store: MarketplaceStore, externalId: string, decision: 'ACCEPT' | 'REJECT', reason?: string): Promise<void>;
  abstract updateStatus(store: MarketplaceStore, externalId: string, status: MarketplaceStatus): Promise<void>;
  abstract pushAvailability(store: MarketplaceStore, items: { externalItemId: string; available: boolean }[]): Promise<void>;
  abstract fetchSettlements(store: MarketplaceStore, since: Date | null): Promise<ExternalSettlement[]>;
}

// In-memory stand-in with the same contract, including an outage switch to exercise graceful degradation.
@Injectable()
export class StubAggregatorAdapter extends AggregatorAdapter {
  readonly inbox = new Map<string, ExternalOrder[]>();
  readonly statements = new Map<string, ExternalSettlement[]>();
  readonly outbox: { provider: string; storeRef: string; action: string; detail: unknown }[] = [];
  private readonly down = new Set<string>();

  private key = (s: MarketplaceStore) => `${s.provider}:${s.storeRef}`;
  private guard(s: MarketplaceStore) {
    if (this.down.has(s.provider)) throw new Error(`${s.provider} API is unavailable (simulated outage)`);
  }

  setOutage(provider: string, down: boolean) {
    if (down) this.down.add(provider);
    else this.down.delete(provider);
  }

  inject(provider: string, storeRef: string, order: ExternalOrder) {
    const k = `${provider}:${storeRef}`;
    this.inbox.set(k, [...(this.inbox.get(k) ?? []), order]);
  }

  injectStatement(provider: string, storeRef: string, s: ExternalSettlement) {
    const k = `${provider}:${storeRef}`;
    this.statements.set(k, [...(this.statements.get(k) ?? []), s]);
  }

  async fetchOrders(store: MarketplaceStore) {
    this.guard(store);
    const k = this.key(store);
    const out = this.inbox.get(k) ?? [];
    this.inbox.set(k, []);
    return out;
  }

  async respond(store: MarketplaceStore, externalId: string, decision: 'ACCEPT' | 'REJECT', reason?: string) {
    this.guard(store);
    this.outbox.push({ ...store, action: decision === 'ACCEPT' ? 'accept' : 'reject', detail: { externalId, reason } });
  }

  async updateStatus(store: MarketplaceStore, externalId: string, status: MarketplaceStatus) {
    this.guard(store);
    this.outbox.push({ ...store, action: 'status', detail: { externalId, status } });
  }

  async pushAvailability(store: MarketplaceStore, items: { externalItemId: string; available: boolean }[]) {
    this.guard(store);
    this.outbox.push({ ...store, action: 'availability', detail: items });
  }

  async fetchSettlements(store: MarketplaceStore) {
    this.guard(store);
    const k = this.key(store);
    const out = this.statements.get(k) ?? [];
    this.statements.set(k, []);
    return out;
  }
}
