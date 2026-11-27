import {
  BadRequestException,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { currentTenantId, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../auth/auth.decorators';
import { requireStub } from '../integrations/adapter-mode';
import { canReadDocument } from './document-access';
import { DocumentProcessingAdapter, LocalDiskStorage, StorageAdapter, StubDocumentProcessing } from './documents.adapters';

// Training videos are large; override with MAX_UPLOAD_MB. Files are buffered in memory, so very large limits need more RAM.
const MAX_MB = Number(process.env.MAX_UPLOAD_MB);
const MAX_BYTES = (MAX_MB > 0 && MAX_MB <= 500 ? MAX_MB : 100) * 1024 * 1024; // bad or missing value falls back to 100 MB

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageAdapter,
    private readonly processing: DocumentProcessingAdapter,
    private readonly audit: AuditService,
  ) {}

  // Stores the original untouched (evidence), then runs QR/OCR extraction keeping confidence and provenance.
  async upload(
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    user: RequestUser,
    subject?: { subjectType?: string; subjectId?: string },
    opts: { extract?: boolean } = { extract: true },
  ) {
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `${currentTenantId()}/${sha256}`;
    await this.storage.put(storageKey, file.buffer);
    const extraction = opts.extract === false ? null : await this.processing.extract(file.buffer, file.mimetype);
    const doc = await this.prisma.db.evidenceDocument.create({
      data: {
        tenantId: '',
        storageKey,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        sha256,
        subjectType: subject?.subjectType ?? null,
        subjectId: subject?.subjectId ?? null,
        extracted: (extraction ?? undefined) as any,
        confidence: extraction?.confidence ?? null,
        createdBy: user.id,
      },
    });
    await this.audit.record({ action: 'document.uploaded', entityType: 'EvidenceDocument', entityId: doc.id, after: { sha256, filename: doc.filename } });
    return doc;
  }

  async get(id: string) {
    const doc = await this.prisma.db.evidenceDocument.findFirst({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async read(id: string) {
    const doc = await this.get(id);
    return { doc, data: await this.storage.get(doc.storageKey) };
  }

  // get/read above are for server code with its own guard. Anything a user asks for by ID goes through these.
  async readable(user: RequestUser, id: string) {
    const doc = await this.get(id);
    if (!(await canReadDocument(this.prisma, user, doc))) throw new NotFoundException('Document not found');
    return doc;
  }

  // Nobody may link a file they cannot open to a record: that would be a way to gain access to it.
  async assertAttachable(user: RequestUser, ids: (string | null | undefined)[]) {
    for (const id of new Set(ids.filter((x): x is string => !!x))) {
      const doc = await this.prisma.db.evidenceDocument.findFirst({ where: { id } });
      if (!doc || !(await canReadDocument(this.prisma, user, doc))) throw new BadRequestException('Unknown evidence document');
    }
  }

  async readableForSubject(user: RequestUser, subjectType: string, subjectId: string) {
    const rows = await this.forSubject(subjectType, subjectId);
    const allowed = await Promise.all(rows.map((d) => canReadDocument(this.prisma, user, d)));
    return rows.filter((_, i) => allowed[i]);
  }

  forSubject(subjectType: string, subjectId: string) {
    return this.prisma.db.evidenceDocument.findMany({ where: { subjectType, subjectId }, orderBy: { createdAt: 'asc' } });
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES } }))
  upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: RequestUser) {
    if (!file) throw new BadRequestException('file is required');
    // No record label from the caller: the label decides who may open the file, so only the server sets it.
    return this.docs.upload(file, user);
  }

  @Get('by-subject/:type/:id') bySubject(@Param('type') type: string, @Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.docs.readableForSubject(user, type, id);
  }

  @Get(':id') get(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.docs.readable(user, id);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: RequestUser, @Res() res: any) {
    await this.docs.readable(user, id);
    const { doc, data } = await this.docs.read(id);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.send(data);
  }
}

@Global()
@Module({
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    { provide: StorageAdapter, useClass: LocalDiskStorage },
    {
      provide: DocumentProcessingAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        requireStub(c, 'DOCUMENT_PROCESSING');
        return new StubDocumentProcessing();
      },
    },
  ],
  exports: [DocumentsService, StorageAdapter, DocumentProcessingAdapter],
})
export class DocumentsModule {}
