import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { DocumentsService } from '../documents/documents.module';

export interface Attachment { id: string; filename: string; mimeType: string; sizeBytes: number }

// Uploaded files are immutable evidence documents; a version keeps a snapshot of their names so readers need no extra lookups.
export async function attachmentSnapshot(prisma: PrismaService, documents: DocumentsService, user: RequestUser, ids: string[] | undefined): Promise<Attachment[]> {
  const want = [...new Set(ids ?? [])];
  if (!want.length) return [];
  await documents.assertAttachable(user, want);
  const docs = await prisma.db.evidenceDocument.findMany({ where: { id: { in: want } } });
  if (docs.length !== want.length) throw new BadRequestException('Unknown attachment');
  return want.map((id) => { const d = docs.find((x) => x.id === id)!; return { id, filename: d.filename, mimeType: d.mimeType, sizeBytes: d.sizeBytes }; });
}
