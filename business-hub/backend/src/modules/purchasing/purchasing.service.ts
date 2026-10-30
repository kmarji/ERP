import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { d, money } from '../../common/money';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SequenceService } from '../../common/prisma/sequence.service';
import { assertBranchAccess } from '../../common/tenancy/branch-scope';
import { currentContext, currentTenantId, RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { PolicyService } from '../policy-engine/policy.service';
import { ApprovalDecidedEvent, ApprovalService, APPROVAL_DECIDED } from '../workflow-engine/approval.service';
import { ExceptionService } from '../workflow-engine/exception.service';

export const BUYER_ROLES = ['OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER'] as const;

export interface RequestLineInput {
  productId: string;
  qty: number;
  unit: string;
  supplierId?: string;
  estUnitPrice?: number;
}

export interface OrderLineInput {
  productId: string;
  qty: number;
  unit: string;
  unitPrice?: number;
}

export interface OrderInput {
  supplierId: string;
  branchId: string;
  stockLocationId: string;
  expectedDate?: string;
  lines: OrderLineInput[];
}

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly exceptions: ExceptionService,
    private readonly sequences: SequenceService,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- purchase requests

  async createRequest(input: { branchId: string; stockLocationId: string; notes?: string; source?: string; lines: RequestLineInput[] }, user: RequestUser) {
    if (user.id !== 'system') assertBranchAccess(user, input.branchId, BUYER_ROLES);
    await this.assertLocation(input.branchId, input.stockLocationId);
    for (const l of input.lines) await this.catalog.unitFactor(l.productId, l.unit);
    return this.prisma.db.$transaction(async (tx) => {
      const number = await this.sequences.next('PR', 'PR', tx);
      const pr = await tx.purchaseRequest.create({
        data: {
          tenantId: '',
          number,
          branchId: input.branchId,
          stockLocationId: input.stockLocationId,
          requestedBy: user.id,
          notes: input.notes ?? null,
          source: input.source ?? 'MANUAL',
          lines: { create: input.lines.map((l) => ({ tenantId: currentTenantId(), productId: l.productId, qty: l.qty, unit: l.unit, supplierId: l.supplierId ?? null, estUnitPrice: l.estUnitPrice ?? null })) },
        },
        include: { lines: true },
      });
      await this.audit.record({ action: 'purchase_request.created', entityType: 'PurchaseRequest', entityId: pr.id, after: { number } }, tx);
      return pr;
    });
  }

  private async estimate(lines: { productId: string; qty: Prisma.Decimal; unit: string; supplierId: string | null; estUnitPrice: Prisma.Decimal | null }[]) {
    let total = d(0);
    for (const l of lines) {
      const price = l.estUnitPrice ?? (await this.agreedPrice(l.supplierId, l.productId, l.unit));
      total = total.plus(d(l.qty).times(d(price)));
    }
    return money(total);
  }

  private async agreedPrice(supplierId: string | null, productId: string, unit: string) {
    const item = await this.prisma.db.supplierItem.findFirst({
      where: { productId, ...(supplierId ? { supplierId } : { preferred: true }) },
    });
    return item && item.unit === unit ? item.agreedPrice : null;
  }

  async submitRequest(id: string) {
    const pr = await this.prisma.db.purchaseRequest.findFirst({ where: { id }, include: { lines: true } });
    if (!pr) throw new NotFoundException('Purchase request not found');
    if (pr.status !== 'DRAFT') throw new ConflictException(`Request is ${pr.status}`);
    const amount = await this.estimate(pr.lines);
    const decision = await this.policy.evaluate('purchase_request.approve', { amount: Number(amount), branchId: pr.branchId });
    if (decision.decision === 'BLOCKED') throw new BadRequestException('Purchase requests are blocked by policy');
    if (decision.decision === 'AUTO') {
      await this.audit.record({ action: 'purchase_request.auto_approved', entityType: 'PurchaseRequest', entityId: id, policyVersion: decision.policyVersion, actorType: 'SYSTEM', after: { amount: amount.toString() } });
      return this.approveRequest(id);
    }
    await this.prisma.db.purchaseRequest.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    await this.approvals.request({ subjectType: 'PurchaseRequest', subjectId: id, action: 'purchase_request.approve', approverRole: decision.approverRole!, amount: Number(amount), branchId: pr.branchId });
    return this.prisma.db.purchaseRequest.findFirstOrThrow({ where: { id } });
  }

  async approveRequest(id: string) {
    const res = await this.prisma.db.purchaseRequest.updateMany({ where: { id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } }, data: { status: 'APPROVED' } });
    if (res.count === 0) {
      const cur = await this.prisma.db.purchaseRequest.findFirst({ where: { id } });
      if (!cur) throw new NotFoundException();
    }
    await this.audit.record({ action: 'purchase_request.approved', entityType: 'PurchaseRequest', entityId: id });
    return this.convertRequest(id);
  }

  // Approved request becomes one PO per supplier. Idempotent: (request, supplier) is unique.
  async convertRequest(id: string) {
    const pr = await this.prisma.db.purchaseRequest.findFirst({ where: { id }, include: { lines: true } });
    if (!pr) throw new NotFoundException('Purchase request not found');
    if (!['APPROVED', 'CONVERTED'].includes(pr.status)) throw new ConflictException(`Request is ${pr.status}`);

    const groups = new Map<string, OrderLineInput[]>();
    const problems: string[] = [];
    for (const l of pr.lines) {
      const item = l.supplierId
        ? await this.prisma.db.supplierItem.findFirst({ where: { productId: l.productId, supplierId: l.supplierId } })
        : await this.prisma.db.supplierItem.findFirst({ where: { productId: l.productId, preferred: true } });
      const supplierId = l.supplierId ?? item?.supplierId;
      if (!supplierId) {
        problems.push(`product ${l.productId}: no supplier`);
        continue;
      }
      const price = l.estUnitPrice ?? (item && item.unit === l.unit ? item.agreedPrice : null);
      if (price === null || price === undefined) {
        problems.push(`product ${l.productId}: no price`);
        continue;
      }
      groups.set(supplierId, [...(groups.get(supplierId) ?? []), { productId: l.productId, qty: Number(l.qty), unit: l.unit, unitPrice: Number(price) }]);
    }
    if (problems.length) {
      await this.exceptions.raise({
        code: 'PR_CANNOT_CONVERT',
        reason: `Approved request ${pr.number} could not be fully converted: ${problems.join('; ')}`,
        evidence: { purchaseRequestId: id, problems },
        ownerRole: 'PROCUREMENT',
        branchId: pr.branchId,
        riskTier: 'LOW',
        availableActions: ['resolve'],
      });
    }
    const orders = [];
    for (const [supplierId, lines] of groups) {
      orders.push(await this.createOrder({ supplierId, branchId: pr.branchId, stockLocationId: pr.stockLocationId, lines }, { purchaseRequestId: id, skipPolicy: true }));
    }
    if (!problems.length) await this.prisma.db.purchaseRequest.updateMany({ where: { id }, data: { status: 'CONVERTED' } });
    return { request: await this.prisma.db.purchaseRequest.findFirstOrThrow({ where: { id } }), orders };
  }

  listRequests(status?: string) {
    return this.prisma.db.purchaseRequest.findMany({ where: { status: status as any }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async getRequest(id: string) {
    const pr = await this.prisma.db.purchaseRequest.findFirst({ where: { id }, include: { lines: true, purchaseOrders: true } });
    if (!pr) throw new NotFoundException();
    return pr;
  }

  // ---------------------------------------------------------------- purchase orders

  async createOrder(input: OrderInput, opts: { purchaseRequestId?: string; skipPolicy?: boolean; user?: RequestUser } = {}) {
    if (opts.user) assertBranchAccess(opts.user, input.branchId, BUYER_ROLES);
    const [supplier, branch] = await Promise.all([
      this.prisma.db.supplier.findFirst({ where: { id: input.supplierId, active: true } }),
      this.prisma.db.branch.findFirst({ where: { id: input.branchId } }),
    ]);
    if (!supplier) throw new BadRequestException('Unknown or inactive supplier');
    if (!branch) throw new BadRequestException('Unknown branch');
    await this.assertLocation(input.branchId, input.stockLocationId);

    const lines: { productId: string; qty: Prisma.Decimal; unit: string; unitPrice: Prisma.Decimal; taxRate: Prisma.Decimal; lineNet: Prisma.Decimal }[] = [];
    for (const l of input.lines) {
      await this.catalog.unitFactor(l.productId, l.unit);
      const product = await this.prisma.db.product.findFirst({ where: { id: l.productId }, include: { taxCode: true } });
      const price = l.unitPrice ?? (await this.agreedPrice(input.supplierId, l.productId, l.unit));
      if (price === null || price === undefined) throw new BadRequestException(`No price for product ${product?.sku ?? l.productId}; supply unitPrice`);
      lines.push({ productId: l.productId, qty: d(l.qty), unit: l.unit, unitPrice: d(price), taxRate: d(product?.taxCode?.rate ?? 0), lineNet: money(d(l.qty).times(d(price))) });
    }
    const subtotal = lines.reduce((s, l) => s.plus(l.lineNet), d(0));
    const taxTotal = lines.reduce((s, l) => s.plus(money(l.lineNet.times(l.taxRate))), d(0));
    const total = subtotal.plus(taxTotal);

    let status: 'ISSUED' | 'PENDING_APPROVAL' = 'ISSUED';
    let approverRole: string | null = null;
    if (!opts.skipPolicy) {
      const decision = await this.policy.evaluate('purchase_order.issue', { amount: Number(total), branchId: input.branchId });
      if (decision.decision === 'BLOCKED') throw new BadRequestException('Purchase orders are blocked by policy');
      if (decision.decision !== 'AUTO') {
        status = 'PENDING_APPROVAL';
        approverRole = decision.approverRole;
      }
    }

    let po;
    try {
      po = await this.prisma.db.$transaction(async (tx) => {
        const number = await this.sequences.next('PO', 'PO', tx);
        const row = await tx.purchaseOrder.create({
          data: {
            tenantId: '',
            number,
            supplierId: input.supplierId,
            legalEntityId: branch.legalEntityId,
            branchId: input.branchId,
            stockLocationId: input.stockLocationId,
            purchaseRequestId: opts.purchaseRequestId ?? null,
            status,
            subtotal,
            taxTotal,
            total,
            expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
            issuedAt: status === 'ISSUED' ? new Date() : null,
            createdBy: currentContext()?.user?.id ?? 'system',
            lines: { create: lines.map((l) => ({ tenantId: currentTenantId(), ...l })) },
          },
          include: { lines: true },
        });
        await this.audit.record({ action: status === 'ISSUED' ? 'purchase_order.issued' : 'purchase_order.created', entityType: 'PurchaseOrder', entityId: row.id, actorType: status === 'ISSUED' && !currentContext()?.user ? 'SYSTEM' : undefined, after: { number, total: total.toString(), status } }, tx);
        return row;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && opts.purchaseRequestId) {
        return this.prisma.db.purchaseOrder.findFirstOrThrow({ where: { purchaseRequestId: opts.purchaseRequestId, supplierId: input.supplierId }, include: { lines: true } });
      }
      throw e;
    }
    if (approverRole) {
      await this.approvals.request({ subjectType: 'PurchaseOrder', subjectId: po.id, action: 'purchase_order.issue', approverRole, amount: Number(total), branchId: input.branchId });
    }
    return po;
  }

  listOrders(status?: string) {
    return this.prisma.db.purchaseOrder.findMany({ where: { status: status as any }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async getOrder(id: string) {
    const po = await this.prisma.db.purchaseOrder.findFirst({ where: { id }, include: { lines: true, receipts: true, invoices: true } });
    if (!po) throw new NotFoundException();
    return po;
  }

  async cancelOrder(id: string) {
    const po = await this.getOrder(id);
    if (po.receipts.some((r) => r.operationalStatus === 'CONFIRMED')) throw new ConflictException('Order already has confirmed receipts');
    await this.prisma.db.purchaseOrder.updateMany({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.record({ action: 'purchase_order.cancelled', entityType: 'PurchaseOrder', entityId: id });
    return this.getOrder(id);
  }

  // ---------------------------------------------------------------- approval execution

  @OnEvent(APPROVAL_DECIDED)
  async onApprovalDecided(e: ApprovalDecidedEvent) {
    if (!['purchase_request.approve', 'purchase_order.issue'].includes(e.action)) return;
    await runWithTenant(e.tenantId, async () => {
      if (e.action === 'purchase_request.approve') {
        if (e.approved) await this.approveRequest(e.subjectId);
        else await this.prisma.db.purchaseRequest.updateMany({ where: { id: e.subjectId }, data: { status: 'REJECTED' } });
      } else if (e.approved) {
        await this.prisma.db.purchaseOrder.updateMany({ where: { id: e.subjectId, status: 'PENDING_APPROVAL' }, data: { status: 'ISSUED', issuedAt: new Date() } });
        await this.audit.record({ action: 'purchase_order.issued', entityType: 'PurchaseOrder', entityId: e.subjectId, after: { approvedBy: e.decidedBy } });
      } else {
        await this.prisma.db.purchaseOrder.updateMany({ where: { id: e.subjectId, status: 'PENDING_APPROVAL' }, data: { status: 'CANCELLED' } });
      }
    }, currentContext()?.tenantId === e.tenantId ? currentContext()?.user : undefined);
  }

  private async assertLocation(branchId: string, stockLocationId: string) {
    const loc = await this.prisma.db.stockLocation.findFirst({ where: { id: stockLocationId, branchId } });
    if (!loc) throw new BadRequestException('Stock location does not belong to the branch');
  }
}
