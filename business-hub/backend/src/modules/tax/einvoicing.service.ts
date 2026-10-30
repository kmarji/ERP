import { Injectable, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentTenantId, runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { IntegrationHandlers, IntegrationsService } from '../integrations/integrations.service';
import { SALE_FINALIZED, SaleFinalizedEvent } from '../pos/orders.service';
import { buildEInvoicePayload, EInvoiceAdapter } from './einvoice';

// Sales are issued first; e-invoice submission is a separate external track with retries and a dead-letter queue.
@Injectable()
export class EInvoicingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly handlers: IntegrationHandlers,
    private readonly adapter: EInvoiceAdapter,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.handlers.register('einvoice', 'submit', (payload: { invoiceId: string }) => this.submit(payload.invoiceId));
  }

  async settings() {
    const t = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: currentTenantId() } });
    const s = (t.settings as any) ?? {};
    return { enabled: !!s.einvoicing?.enabled };
  }

  async setEnabled(enabled: boolean) {
    const t = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: currentTenantId() } });
    const settings = { ...((t.settings as any) ?? {}), einvoicing: { enabled } };
    await this.prisma.raw.tenant.update({ where: { id: t.id }, data: { settings } });
    await this.audit.record({ action: 'settings.einvoicing', entityType: 'Tenant', entityId: t.id, after: { enabled } });
    return { enabled };
  }

  @OnEvent(SALE_FINALIZED)
  async onSale(e: SaleFinalizedEvent) {
    await runWithTenant(e.tenantId, async () => {
      if (!(await this.settings()).enabled) return;
      const invoice = await this.prisma.db.invoice.findFirst({ where: { orderId: e.orderId } });
      if (!invoice || invoice.externalStatus !== 'NOT_REQUIRED') return;
      await this.prisma.db.invoice.updateMany({ where: { id: invoice.id }, data: { externalStatus: 'PENDING' } });
      await this.prisma.db.order.updateMany({ where: { id: e.orderId }, data: { externalStatus: 'PENDING' } });
      await this.integrations.enqueue({ adapter: 'einvoice', operation: 'submit', payload: { invoiceId: invoice.id }, idempotencyKey: `einvoice:${invoice.id}` });
    });
  }

  private async submit(invoiceId: string) {
    const invoice = await this.prisma.db.invoice.findFirstOrThrow({ where: { id: invoiceId } });
    if (invoice.externalStatus === 'ACCEPTED') return { status: 'ACCEPTED', reference: invoice.externalRef };
    const order = await this.prisma.db.order.findFirstOrThrow({ where: { id: invoice.orderId }, include: { lines: true, tenders: true } });
    const branch = await this.prisma.db.branch.findFirstOrThrow({ where: { id: order.branchId } });
    const entity = await this.prisma.db.legalEntity.findFirstOrThrow({ where: { id: branch.legalEntityId } });
    const payload = buildEInvoicePayload({
      invoice: { number: invoice.number, issuedAt: invoice.issuedAt, subtotal: invoice.subtotal.toString(), discountTotal: invoice.discountTotal.toString(), taxTotal: invoice.taxTotal.toString(), total: invoice.total.toString() },
      lines: order.lines.filter((l) => !l.voided).map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice.toString(), net: l.net.toString(), taxRate: l.taxRate.toString(), tax: l.tax.toString() })),
      seller: { name: entity.name, taxNumber: entity.taxNumber },
      tenders: order.tenders.filter((t) => t.status === 'CAPTURED').map((t) => t.method),
    });
    const res = await this.adapter.submit(payload);
    if (res.status === 'REJECTED') {
      await this.prisma.db.invoice.updateMany({ where: { id: invoiceId }, data: { externalStatus: 'REJECTED' } });
      await this.prisma.db.order.updateMany({ where: { id: order.id }, data: { externalStatus: 'REJECTED' } });
      // Rejections are not retried blindly: they need a human to fix the cause (e.g. the legal entity's tax number).
      return { status: 'REJECTED', reason: res.reason };
    }
    await this.prisma.db.invoice.updateMany({ where: { id: invoiceId }, data: { externalStatus: 'ACCEPTED', externalRef: res.reference } });
    await this.prisma.db.order.updateMany({ where: { id: order.id }, data: { externalStatus: 'ACCEPTED' } });
    return { status: 'ACCEPTED', reference: res.reference };
  }

  list(status?: string) {
    return this.prisma.db.invoice.findMany({ where: { externalStatus: status ? (status as any) : { not: 'NOT_REQUIRED' } }, orderBy: { issuedAt: 'desc' }, take: 200 });
  }

  // After fixing the cause of a rejection, finance can resubmit.
  async resubmit(invoiceId: string) {
    await this.prisma.db.invoice.updateMany({ where: { id: invoiceId, externalStatus: 'REJECTED' }, data: { externalStatus: 'PENDING' } });
    return this.integrations.enqueue({ adapter: 'einvoice', operation: 'submit', payload: { invoiceId }, idempotencyKey: `einvoice:${invoiceId}:retry:${Date.now()}` });
  }
}
