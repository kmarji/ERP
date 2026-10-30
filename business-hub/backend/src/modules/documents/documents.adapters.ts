import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export abstract class StorageAdapter {
  abstract put(key: string, data: Buffer): Promise<void>;
  abstract get(key: string): Promise<Buffer>;
  abstract delete(key: string): Promise<void>;
}

@Injectable()
export class LocalDiskStorage extends StorageAdapter {
  private readonly root: string;

  constructor(config: ConfigService) {
    super();
    this.root = resolve(config.get<string>('STORAGE_DIR') ?? './storage');
  }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    // Keys are generated server-side, but never let a key escape the storage root.
    if (!p.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export interface ExtractedField {
  value: string | number | null;
  confidence: number;
  source: string; // provenance: 'qr' | 'ocr' | 'stub-json' ...
}

export interface ExtractionResult {
  qrPayload: string | null;
  fields: Record<string, ExtractedField>;
  lines: Record<string, unknown>[];
  confidence: number;
}

export abstract class DocumentProcessingAdapter {
  abstract extract(data: Buffer, mimeType: string): Promise<ExtractionResult>;
}

// Stub: understands JSON "invoice fixtures" ({ fields: {...}, lines: [...], qr?: string }) so workflows
// can be exercised end to end. Anything else yields an empty, zero-confidence result, which the receiving
// workflow must route to a human. Replace with a real OCR/QR provider once one is chosen.
@Injectable()
export class StubDocumentProcessing extends DocumentProcessingAdapter {
  async extract(data: Buffer, mimeType: string): Promise<ExtractionResult> {
    const empty: ExtractionResult = { qrPayload: null, fields: {}, lines: [], confidence: 0 };
    if (mimeType !== 'application/json') return empty;
    try {
      const doc = JSON.parse(data.toString('utf8'));
      const confidence = typeof doc.confidence === 'number' ? doc.confidence : 0.95;
      const fields: Record<string, ExtractedField> = {};
      for (const [k, v] of Object.entries<any>(doc.fields ?? {})) {
        fields[k] = { value: v, confidence, source: 'stub-json' };
      }
      return { qrPayload: doc.qr ?? null, fields, lines: Array.isArray(doc.lines) ? doc.lines : [], confidence };
    } catch {
      return empty;
    }
  }
}
