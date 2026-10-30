import { Injectable } from '@nestjs/common';
import { PrismaService, ScopedClient } from '../../common/prisma/prisma.service';
import { currentContext } from '../../common/tenancy/tenant-context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome?: string;
  policyVersion?: number | null;
  externalResponse?: unknown;
  actorId?: string | null;
  actorType?: 'USER' | 'SYSTEM';
}

type AuditTx = Pick<ScopedClient, 'auditEvent'>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  // Pass the caller's transaction client so compliance-critical audit rows commit atomically with the business write.
  async record(entry: AuditEntry, tx?: AuditTx) {
    const ctx = currentContext();
    const client = tx ?? this.prisma.db;
    return client.auditEvent.create({
      data: {
        tenantId: ctx?.tenantId as string,
        actorId: entry.actorId ?? ctx?.user?.id ?? null,
        actorType: entry.actorType ?? (ctx?.user?.isSystem || !ctx?.user ? 'SYSTEM' : 'USER'),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: (entry.before ?? undefined) as any,
        after: (entry.after ?? undefined) as any,
        outcome: entry.outcome ?? 'SUCCESS',
        policyVersion: entry.policyVersion ?? null,
        externalResponse: (entry.externalResponse ?? undefined) as any,
        correlationId: ctx?.correlationId ?? null,
      },
    });
  }

  list(filter: { entityType?: string; entityId?: string; action?: string; take?: number; skip?: number }) {
    return this.prisma.db.auditEvent.findMany({
      where: {
        entityType: filter.entityType,
        entityId: filter.entityId,
        action: filter.action ? { contains: filter.action } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.take ?? 50, 200),
      skip: filter.skip ?? 0,
    });
  }
}
