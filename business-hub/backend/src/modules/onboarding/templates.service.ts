import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { StorageAdapter } from '../documents/documents.adapters';
import { checkTemplate } from './contract-template';

export type Upload = { originalname: string; buffer: Buffer };
const view = <T extends { storageKey: string }>({ storageKey: _k, ...t }: T) => t;

@Injectable()
export class ContractTemplatesService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageAdapter, private readonly audit: AuditService) {}

  async list() {
    return (await this.prisma.db.contractTemplate.findMany({ orderBy: { name: 'asc' } })).map(view);
  }

  private async find(id: string) {
    const t = await this.prisma.db.contractTemplate.findFirst({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  private async store(file: Upload | undefined) {
    if (!file) throw new BadRequestException('Choose a Word (.docx) file');
    // The upload library reads names as latin1; Arabic names need converting back.
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!/\.docx$/i.test(filename)) throw new BadRequestException('The template must be a Word (.docx) file');
    checkTemplate(file.buffer);
    const storageKey = `${currentTenantId()}/contract-templates/${randomUUID()}`;
    await this.storage.put(storageKey, file.buffer);
    return { filename, storageKey };
  }

  async create(input: { name: string; contractType?: string }, file: Upload | undefined, user: RequestUser) {
    const row = await this.prisma.db.contractTemplate.create({ data: { tenantId: '', name: input.name.trim(), contractType: input.contractType || null, createdBy: user.id, ...(await this.store(file)) } });
    await this.audit.record({ action: 'contract_template.created', entityType: 'ContractTemplate', entityId: row.id, after: { name: row.name, filename: row.filename } });
    return view(row);
  }

  async change(id: string, input: { name?: string; contractType?: string; active?: boolean }) {
    await this.find(id);
    await this.prisma.db.contractTemplate.updateMany({ where: { id }, data: { name: input.name?.trim(), active: input.active, ...(input.contractType === undefined ? {} : { contractType: input.contractType || null }) } });
    await this.audit.record({ action: 'contract_template.changed', entityType: 'ContractTemplate', entityId: id, after: input });
    return view(await this.find(id));
  }

  async replace(id: string, file: Upload | undefined) {
    await this.find(id);
    const stored = await this.store(file);
    await this.prisma.db.contractTemplate.updateMany({ where: { id }, data: stored });
    await this.audit.record({ action: 'contract_template.file_replaced', entityType: 'ContractTemplate', entityId: id, after: { filename: stored.filename } });
    return view(await this.find(id));
  }

  async file(id: string) {
    const t = await this.find(id);
    return { filename: t.filename, data: await this.storage.get(t.storageKey) };
  }

  // The file of a template that may be used for a new offer of this contract type.
  async forOffer(id: string, contractType: string) {
    const t = await this.find(id);
    if (!t.active) throw new BadRequestException('That contract template is not active');
    if (t.contractType && t.contractType !== contractType) throw new BadRequestException('That contract template is for a different contract type');
    return this.storage.get(t.storageKey);
  }
}
