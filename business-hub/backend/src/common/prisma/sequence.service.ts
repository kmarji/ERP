import { Injectable } from '@nestjs/common';
import { currentTenantId } from '../tenancy/tenant-context';
import { PrismaService, ScopedClient } from './prisma.service';

type Tx = ScopedClient | Parameters<Parameters<ScopedClient['$transaction']>[0]>[0];

// Gap-tolerant, atomic per-tenant document numbers (PR-000001, PO-000001, ...).
@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  async next(key: string, prefix: string, tx: Tx = this.prisma.db): Promise<string> {
    const tenantId = currentTenantId();
    const row = await tx.sequence.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: { tenantId, key, next: 1 },
      update: { next: { increment: 1 } },
    });
    return `${prefix}-${String(row.next).padStart(6, '0')}`;
  }
}
