import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { dateOnly } from '../../common/time';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { parseRules, PayrollRules, PLACEHOLDER_NOTE } from './payroll-rules';

export interface ActiveRules {
  id: string;
  version: number;
  verified: boolean;
  rules: PayrollRules;
}

@Injectable()
export class PayrollRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // The rule set in force on a date: the ACTIVE version with the latest effectiveFrom not after it.
  // A tenant with none gets an unverified placeholder set, so calculations work but cannot be finalized.
  async activeFor(date: Date): Promise<ActiveRules> {
    let row = await this.prisma.db.payrollRuleSet.findFirst({ where: { status: 'ACTIVE', effectiveFrom: { lte: date } }, orderBy: { effectiveFrom: 'desc' } });
    if (!row) {
      const any = await this.prisma.db.payrollRuleSet.findFirst({ where: { status: 'ACTIVE' } });
      if (!any) row = await this.createDefault();
      else row = any;
    }
    return { id: row.id, version: row.version, verified: !!row.verifiedAt, rules: parseRules(row.rules) };
  }

  private async createDefault() {
    const last = await this.prisma.db.payrollRuleSet.findFirst({ orderBy: { version: 'desc' } });
    return this.prisma.db.payrollRuleSet.create({ data: { tenantId: '', version: (last?.version ?? 0) + 1, effectiveFrom: dateOnly('2000-01-01'), rules: parseRules({}) as any, notes: PLACEHOLDER_NOTE, status: 'ACTIVE', createdBy: 'system' } });
  }

  list() {
    return this.prisma.db.payrollRuleSet.findMany({ orderBy: { version: 'desc' } });
  }

  async create(input: { effectiveFrom: string; rules: unknown; notes?: string }, user: RequestUser) {
    let parsed: PayrollRules;
    try {
      parsed = parseRules(input.rules);
    } catch (e: any) {
      throw new BadRequestException(`Invalid rules: ${e.message}`);
    }
    const last = await this.prisma.db.payrollRuleSet.findFirst({ orderBy: { version: 'desc' } });
    const row = await this.prisma.db.payrollRuleSet.create({ data: { tenantId: '', version: (last?.version ?? 0) + 1, effectiveFrom: dateOnly(input.effectiveFrom), rules: parsed as any, notes: input.notes ?? null, status: 'DRAFT', createdBy: user.id } });
    await this.audit.record({ action: 'payroll_rules.created', entityType: 'PayrollRuleSet', entityId: row.id, after: { version: row.version, effectiveFrom: input.effectiveFrom } });
    return row;
  }

  async activate(id: string, user: RequestUser) {
    const row = await this.prisma.db.payrollRuleSet.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Rule set not found');
    if (row.status === 'ACTIVE') return row;
    // An earlier version with the same effective date is replaced; versions with other dates stay in force for their periods.
    await this.prisma.db.payrollRuleSet.updateMany({ where: { status: 'ACTIVE', effectiveFrom: row.effectiveFrom, id: { not: id } }, data: { status: 'RETIRED' } });
    await this.prisma.db.payrollRuleSet.updateMany({ where: { id }, data: { status: 'ACTIVE' } });
    await this.audit.record({ action: 'payroll_rules.activated', entityType: 'PayrollRuleSet', entityId: id, after: { by: user.id, version: row.version } });
    return this.prisma.db.payrollRuleSet.findFirstOrThrow({ where: { id } });
  }

  // Someone accountable states that these values match current law. Finalizing payroll needs this on the rules in force.
  async verify(id: string, note: string, user: RequestUser) {
    const row = await this.prisma.db.payrollRuleSet.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Rule set not found');
    if (row.status === 'RETIRED') throw new ConflictException('A retired rule set cannot be verified');
    if (row.createdBy === user.id) throw new ConflictException('The author of a rule set cannot be the one who verifies it');
    await this.prisma.db.payrollRuleSet.updateMany({ where: { id }, data: { verifiedBy: user.id, verifiedAt: new Date(), verificationNote: note } });
    await this.audit.record({ action: 'payroll_rules.verified', entityType: 'PayrollRuleSet', entityId: id, after: { by: user.id, note } });
    return this.prisma.db.payrollRuleSet.findFirstOrThrow({ where: { id } });
  }
}
