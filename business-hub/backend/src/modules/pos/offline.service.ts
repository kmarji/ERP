import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { MenuService } from '../menu/menu.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ExceptionService } from '../workflow-engine/exception.service';
import { OrdersService } from './orders.service';
import { lineAmounts } from './pos-math';
import { POS_ROLES } from './shifts.service';

export interface OfflineSale {
  clientOrderId: string;
  channel?: 'DINE_IN' | 'TAKEAWAY' | 'PICKUP';
  tableId?: string;
  notes?: string;
  lines: { menuItemId: string; variantId?: string; modifierIds?: string[]; qty: number; unitPrice?: number; notes?: string }[];
  tenders: { method: string; tendered: number }[];
}

export interface OfflineOp {
  opId: string;
  kind: string;
  capturedAt: string;
  sale?: OfflineSale;
}

export interface OpResult {
  opId: string;
  status: 'APPLIED' | 'DUPLICATE' | 'REJECTED';
  orderId?: string;
  orderNumber?: string;
  reason?: string;
  code?: string;
  flags?: string[];
}

// What a device may do without a connection. Anything needing a live external system is blocked and explained.
export const OFFLINE_CAPABILITIES = {
  supported: ['SALE with CASH tender (dine-in, takeaway, pickup)'],
  blocked: [
    { action: 'CARD / DIGITAL payment', why: 'needs a live terminal authorization' },
    { action: 'GIFT_CARD tender and gift card sales', why: 'balances live on the server' },
    { action: 'Vouchers and loyalty redemption', why: 'must be validated against server state' },
    { action: 'Refunds', why: 'need approval and the original payment record' },
    { action: 'Delivery, online and aggregator orders', why: 'arrive from external channels' },
  ],
};

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

@Injectable()
export class OfflineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly menu: MenuService,
    private readonly policy: PolicyService,
    private readonly exceptions: ExceptionService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------- device enrollment

  // The key is returned once and stored hashed; losing the device means revoking it, which cuts off sync immediately.
  async enroll(input: { branchId: string; name: string }, user: RequestUser) {
    assertBranchAccess(user, input.branchId, ['OWNER', 'BRANCH_MANAGER']);
    const key = randomBytes(24).toString('hex');
    const device = await this.prisma.db.device.create({ data: { tenantId: '', branchId: input.branchId, name: input.name, keyHash: hash(key), enrolledBy: user.id } });
    await this.audit.record({ action: 'device.enrolled', entityType: 'Device', entityId: device.id, after: { name: input.name, branchId: input.branchId } });
    return { id: device.id, key, branchId: device.branchId, name: device.name };
  }

  async list(user: RequestUser) {
    const rows = await this.prisma.db.device.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.filter((r) => { try { assertBranchAccess(user, r.branchId, ['OWNER', 'BRANCH_MANAGER']); return true; } catch { return false; } }).map(({ keyHash: _k, ...r }) => r);
  }

  async revoke(id: string, user: RequestUser) {
    const dev = await this.prisma.db.device.findFirst({ where: { id } });
    if (!dev) throw new NotFoundException('Device not found');
    assertBranchAccess(user, dev.branchId, ['OWNER', 'BRANCH_MANAGER']);
    await this.prisma.db.device.updateMany({ where: { id }, data: { active: false } });
    await this.audit.record({ action: 'device.revoked', entityType: 'Device', entityId: id });
    return { revoked: true };
  }

  private async verify(deviceId: string | undefined, key: string | undefined, user: RequestUser) {
    if (!deviceId || !key) throw new UnauthorizedException('Device credentials are required (x-device-id, x-device-key)');
    const dev = await this.prisma.db.device.findFirst({ where: { id: deviceId } });
    const a = Buffer.from(hash(key));
    const b = Buffer.from(dev?.keyHash ?? '0'.repeat(64));
    if (!dev || !dev.active || a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Unknown or revoked device');
    assertBranchAccess(user, dev.branchId, POS_ROLES);
    await this.prisma.db.device.updateMany({ where: { id: dev.id }, data: { lastSeenAt: new Date() } });
    return dev;
  }

  async issueSession(deviceId: string | undefined, key: string | undefined, user: RequestUser) {
    await this.verify(deviceId, key, user);
    const expiresIn = this.config.get<string>('JWT_POS_EXPIRES_IN') ?? '12h';
    const accessToken = await this.jwt.signAsync({ sub: user.id, tid: user.tenantId, email: user.email }, { expiresIn });
    await this.audit.record({ action: 'device.session_issued', entityType: 'Device', entityId: deviceId, after: { expiresIn } });
    return { accessToken, tokenType: 'Bearer', expiresIn };
  }

  async bundle(deviceId: string | undefined, key: string | undefined, user: RequestUser) {
    const dev = await this.verify(deviceId, key, user);
    return { version: new Date().toISOString(), branchId: dev.branchId, capabilities: OFFLINE_CAPABILITIES, menu: await this.menu.offlineBundle(dev.branchId) };
  }

  // ---------------------------------------------------------------- sync

  async sync(deviceId: string | undefined, key: string | undefined, ops: OfflineOp[], user: RequestUser) {
    const dev = await this.verify(deviceId, key, user);
    const results: OpResult[] = [];
    // Sequential on purpose: operations from one device are applied in the order they happened.
    for (const op of ops) results.push(await this.apply(dev, op, user));
    return { results, applied: results.filter((r) => r.status === 'APPLIED').length, duplicates: results.filter((r) => r.status === 'DUPLICATE').length, rejected: results.filter((r) => r.status === 'REJECTED').length };
  }

  async retry(id: string, user: RequestUser, shiftId?: string) {
    const op = await this.prisma.db.offlineOperation.findFirst({ where: { id } });
    if (!op) throw new NotFoundException('Operation not found');
    const dev = await this.prisma.db.device.findFirstOrThrow({ where: { id: op.deviceId } });
    assertBranchAccess(user, dev.branchId, ['OWNER', 'BRANCH_MANAGER']);
    if (op.status === 'APPLIED') return { opId: op.opId, status: 'DUPLICATE' as const, ...(op.result as object) };
    return this.apply(dev, op.payload as unknown as OfflineOp, user, { shiftId, retrying: true });
  }

  listOperations(status?: 'APPLIED' | 'REJECTED') {
    return this.prisma.db.offlineOperation.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  private async apply(dev: { id: string; branchId: string }, op: OfflineOp, user: RequestUser, opts: { shiftId?: string; retrying?: boolean } = {}): Promise<OpResult> {
    const shapeError = this.shapeError(op);
    if (shapeError && (typeof (op as any)?.opId !== 'string' || (op as any).opId.length < 8)) return { opId: String((op as any)?.opId ?? ''), status: 'REJECTED', code: 'INVALID', reason: shapeError };
    const existing = await this.prisma.db.offlineOperation.findFirst({ where: { deviceId: dev.id, opId: op.opId } });
    if (existing?.status === 'APPLIED') return { opId: op.opId, status: 'DUPLICATE', ...(existing.result as object) };
    if (existing && !opts.retrying) return { opId: op.opId, status: 'REJECTED', reason: existing.error ?? 'Rejected earlier', code: 'PREVIOUSLY_REJECTED' };

    const reject = async (code: string, reason: string, orderId?: string): Promise<OpResult> => {
      await this.record(dev.id, op, 'REJECTED', { error: `${code}: ${reason}`, orderId });
      // The payload is kept and a person is told, so a sale that really happened is never silently lost.
      const open = await this.prisma.db.exception.findMany({ where: { code: 'POS_OFFLINE_REJECTED', status: 'NOTIFIED' } });
      if (!open.some((e) => (e.evidence as any)?.opId === op.opId && (e.evidence as any)?.deviceId === dev.id)) {
        await this.exceptions.raise({
          code: 'POS_OFFLINE_REJECTED',
          reason: `Offline operation ${op.opId} from a POS device was not applied (${code}): ${reason}`,
          evidence: { deviceId: dev.id, opId: op.opId, kind: op.kind, code, clientOrderId: op.sale?.clientOrderId },
          impact: 'A sale recorded offline is not in the books; fix the cause and retry the operation',
          branchId: dev.branchId,
          ownerRole: 'BRANCH_MANAGER',
          riskTier: 'MEDIUM',
          availableActions: ['resolve'],
        });
      }
      return { opId: op.opId, status: 'REJECTED', code, reason };
    };

    if (shapeError) return reject('INVALID', shapeError);
    if (op.kind !== 'SALE' || !op.sale) return reject('BLOCKED_OFFLINE', `Operation kind '${op.kind}' cannot be performed offline`);
    const sale = op.sale;
    if (!sale.clientOrderId) return reject('INVALID', 'clientOrderId is required');
    if (!sale.lines?.length) return reject('INVALID', 'A sale needs at least one line');
    const badTender = sale.tenders?.find((t) => t.method !== 'CASH');
    if (!sale.tenders?.length || badTender) return reject('UNSUPPORTED_TENDER', `Only CASH can be taken offline${badTender ? ` (got ${badTender.method})` : ''}`);
    const capturedAt = new Date(op.capturedAt);
    if (Number.isNaN(capturedAt.getTime())) return reject('INVALID', 'capturedAt is not a valid timestamp');

    let orderId: string | undefined;
    const flags: string[] = [];
    try {
      // Validate against the catalog as it was when the sale happened, and note price drift (kept, never overridden).
      const priced: { qty: number; unitPrice: number; taxRate: number }[] = [];
      for (const l of sale.lines) {
        const r = await this.menu.resolveLine({ menuItemId: l.menuItemId, variantId: l.variantId, modifierIds: l.modifierIds, branchId: dev.branchId, at: capturedAt });
        const charged = l.unitPrice ?? Number(r.unitPrice);
        priced.push({ qty: l.qty, unitPrice: charged, taxRate: Number(r.taxRate) });
        const pct = Number(r.unitPrice) === 0 ? 0 : (Math.abs(charged - Number(r.unitPrice)) / Number(r.unitPrice)) * 100;
        if (pct > 0) {
          const decision = await this.policy.evaluate('pos.offline_price_variance', { variancePct: pct, amount: Math.abs(charged - Number(r.unitPrice)) * l.qty, branchId: dev.branchId });
          if (decision.decision !== 'AUTO') flags.push(`PRICE_DRIFT:${l.menuItemId}:${pct.toFixed(1)}%`);
        }
      }
      const total = priced.reduce((s, p) => s.plus(lineAmounts(p.qty, d(p.unitPrice), d(p.taxRate)).total), d(0));
      const cash = sale.tenders.reduce((s, t) => s.plus(t.tendered), d(0));
      if (cash.lt(total)) return reject('UNDERPAID', `Cash ${money(cash)} is less than the sale total ${money(total)}`);

      const key = `offline:${dev.id}:${op.opId}`;
      const order = await this.orders.create(
        { idempotencyKey: key, branchId: dev.branchId, channel: sale.channel ?? 'DINE_IN', tableId: sale.tableId, notes: sale.notes, lines: sale.lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, modifierIds: l.modifierIds, qty: l.qty, notes: l.notes, unitPriceOverride: l.unitPrice })) },
        user,
        { source: 'OFFLINE', externalRef: sale.clientOrderId, createdAt: capturedAt, shiftId: opts.shiftId },
      );
      orderId = order.id;
      for (const [i, t] of sale.tenders.entries()) {
        await this.orders.addTender(order.id, { method: 'CASH', tendered: t.tendered, idempotencyKey: `${key}:t${i}` }, user, { useOrderShift: true });
      }
      const done = await this.orders.complete(order.id, user);
      const result = { orderId: done.id, orderNumber: done.number, flags };
      await this.record(dev.id, op, 'APPLIED', { result, orderId: done.id });
      if (flags.length) {
        await this.exceptions.raise({
          code: 'POS_OFFLINE_PRICE_CONFLICT',
          reason: `Offline sale ${done.number} was charged at prices that differ from the current menu (${flags.length} line(s)); the customer's price was honoured`,
          evidence: { orderId: done.id, flags },
          branchId: dev.branchId,
          ownerRole: 'BRANCH_MANAGER',
          riskTier: 'LOW',
          availableActions: ['resolve'],
        });
      }
      return { opId: op.opId, status: 'APPLIED', ...result };
    } catch (e: any) {
      if (orderId) await this.orders.voidOrder(orderId, `Offline sync failed: ${e.message}`, user).catch(() => undefined);
      const code = e instanceof ForbiddenException ? 'FORBIDDEN' : e instanceof BadRequestException ? 'INVALID' : 'CONFLICT';
      return reject(code, e.message ?? 'Unexpected error', orderId);
    }
  }

  // Hand validation keeps one bad operation from failing the whole batch.
  private shapeError(raw: any): string | null {
    if (!raw || typeof raw !== 'object') return 'operation must be an object';
    if (typeof raw.opId !== 'string' || raw.opId.length < 8) return 'opId (at least 8 characters) is required';
    if (typeof raw.kind !== 'string') return 'kind is required';
    if (typeof raw.capturedAt !== 'string') return 'capturedAt is required';
    if (raw.kind !== 'SALE') return null; // blocked kinds are explained by the service, not treated as malformed
    const s = raw.sale;
    if (!s || typeof s !== 'object') return 'sale is required for a SALE operation';
    if (typeof s.clientOrderId !== 'string' || !s.clientOrderId) return 'sale.clientOrderId is required';
    if (!Array.isArray(s.lines) || !s.lines.length) return 'sale.lines must be a non-empty array';
    for (const l of s.lines) {
      if (!l || typeof l.menuItemId !== 'string') return 'every line needs a menuItemId';
      if (!Number.isInteger(l.qty) || l.qty < 1) return 'every line needs an integer qty >= 1';
      if (l.unitPrice !== undefined && (typeof l.unitPrice !== 'number' || l.unitPrice < 0)) return 'unitPrice must be a non-negative number';
    }
    if (!Array.isArray(s.tenders) || !s.tenders.length) return 'sale.tenders must be a non-empty array';
    for (const t of s.tenders) if (!t || typeof t.method !== 'string' || typeof t.tendered !== 'number' || t.tendered < 0) return 'every tender needs a method and a non-negative tendered amount';
    if (s.channel !== undefined && !['DINE_IN', 'TAKEAWAY', 'PICKUP'].includes(s.channel)) return 'channel must be DINE_IN, TAKEAWAY or PICKUP offline';
    return null;
  }

  private async record(deviceId: string, op: OfflineOp, status: 'APPLIED' | 'REJECTED', extra: { result?: unknown; error?: string; orderId?: string }) {
    const data = { kind: op.kind, payload: op as any, status, result: (extra.result ?? null) as any, error: extra.error ?? null, orderId: extra.orderId ?? null };
    const tenantId = (await this.prisma.db.device.findFirstOrThrow({ where: { id: deviceId } })).tenantId;
    await this.prisma.db.offlineOperation.upsert({
      where: { tenantId_deviceId_opId: { tenantId, deviceId, opId: op.opId } },
      create: { tenantId, deviceId, opId: op.opId, ...data },
      update: data,
    });
  }
}
