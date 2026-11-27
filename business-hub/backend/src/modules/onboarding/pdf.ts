import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export abstract class PdfConverter {
  abstract convert(docx: Buffer): Promise<Buffer>;
}

// LibreOffice, installed in the server image. Each run has its own profile so two conversions never block each other.
@Injectable()
export class SofficeConverter extends PdfConverter {
  async convert(docx: Buffer) {
    const dir = await mkdtemp(join(tmpdir(), 'contract-'));
    try {
      await writeFile(join(dir, 'contract.docx'), docx);
      await run(process.env.SOFFICE_PATH ?? 'soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, join(dir, 'contract.docx')], { timeout: 60_000 });
      return await readFile(join(dir, 'contract.pdf'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
