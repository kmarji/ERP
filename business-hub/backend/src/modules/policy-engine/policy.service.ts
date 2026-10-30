import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RiskTier } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { decide, EvalInput, EvalResult, PolicyRules } from './policy-decision';

@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // The single decision point every module calls: AUTO | DELEGATED | APPROVAL_REQUIRED | BLOCKED.
  async evaluate(policyKey: string, input: EvalInput = {}): Promise<EvalResult> {
    const [versions, limits, roles] = await Promise.all([
      this.prisma.db.policy.findMany({ where: { key: policyKey }, orderBy: { version: 'desc' } }),
      this.prisma.db.approvalLimit.findMany({ where: { policyKey } }),
      this.prisma.db.role.findMany(),
    ]);
    const active = versions.find((v) => v.active) ?? null;
    const roleRank = Object.fromEntries(roles.map((r) => [r.key, r.rank]));
    return decide(
      active ? { version: active.version, riskTier: active.riskTier, rules: active.rules as PolicyRules } : null,
      versions.length > 0 && !active,
      limits.map((l) => ({
        roleKey: l.roleKey,
        maxAmount: Number(l.maxAmount),
        legalEntityId: l.legalEntityId,
        branchId: l.branchId,
        category: l.category,
      })),
      roleRank,
      input,
    );
  }

  list() {
    return this.prisma.db.policy.findMany({ orderBy: [{ key: 'asc' }, { version: 'desc' }] });
  }

  // New version becomes active; older versions stay for history and rollback.
  async createVersion(key: string, riskTier: RiskTier, rules: PolicyRules, createdBy?: string) {
    const created = await this.prisma.db.$transaction(async (tx) => {
      const last = await tx.policy.findFirst({ where: { key }, orderBy: { version: 'desc' } });
      await tx.policy.updateMany({ where: { key, active: true }, data: { active: false } });
      const row = await tx.policy.create({
        data: { tenantId: '', key, version: (last?.version ?? 0) + 1, active: true, riskTier, rules: rules as any, createdBy },
      });
      await this.audit.record(
        { action: 'policy.version_created', entityType: 'Policy', entityId: row.id, after: row, policyVersion: row.version },
        tx,
      );
      return row;
    });
    return created;
  }

  // Controlled rollback / deactivation: exactly one version active, or none (which blocks the action).
  async activate(key: string, version: number | null) {
    return this.prisma.db.$transaction(async (tx) => {
      if (version !== null) {
        const target = await tx.policy.findFirst({ where: { key, version } });
        if (!target) throw new NotFoundException(`Policy ${key} v${version} not found`);
      }
      await tx.policy.updateMany({ where: { key, active: true }, data: { active: false } });
      if (version !== null) await tx.policy.updateMany({ where: { key, version }, data: { active: true } });
      await this.audit.record(
        { action: version === null ? 'policy.deactivated' : 'policy.activated', entityType: 'Policy', entityId: key, policyVersion: version },
        tx,
      );
      return { key, activeVersion: version };
    });
  }

  listLimits() {
    return this.prisma.db.approvalLimit.findMany({ orderBy: [{ policyKey: 'asc' }, { maxAmount: 'asc' }] });
  }

  async upsertLimit(input: {
    policyKey: string;
    roleKey: string;
    maxAmount: number;
    legalEntityId?: string;
    branchId?: string;
    category?: string;
  }) {
    if (input.maxAmount < 0) throw new BadRequestException('maxAmount must be >= 0');
    const row = await this.prisma.db.approvalLimit.create({
      data: {
        tenantId: '',
        policyKey: input.policyKey,
        roleKey: input.roleKey,
        maxAmount: input.maxAmount,
        legalEntityId: input.legalEntityId ?? null,
        branchId: input.branchId ?? null,
        category: input.category ?? null,
      },
    });
    await this.audit.record({ action: 'approval_limit.created', entityType: 'ApprovalLimit', entityId: row.id, after: row });
    return row;
  }

  async deleteLimit(id: string) {
    const row = await this.prisma.db.approvalLimit.findFirst({ where: { id } });
    if (!row) throw new NotFoundException();
    await this.prisma.db.approvalLimit.deleteMany({ where: { id } });
    await this.audit.record({ action: 'approval_limit.deleted', entityType: 'ApprovalLimit', entityId: id, before: row });
    return { deleted: true };
  }
}
