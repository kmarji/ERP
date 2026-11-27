import { BadRequestException } from '@nestjs/common';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

export const MARKERS = [
  'employee_name', 'employee_name_ar', 'nationality', 'job_title', 'job_title_ar', 'branch', 'employer_name', 'tax_number',
  'start_date', 'end_date', 'contract_type', 'basic_salary', 'allowances', 'total_salary', 'probation_months', 'weekly_hours', 'offer_number', 'today',
] as const;
export type MarkerValues = Partial<Record<(typeof MARKERS)[number], string>>;

// Compiles the document (body, headers, footers), noting every marker it holds.
function open(file: Buffer) {
  const found = new Set<string>();
  try {
    const zip = new PizZip(file);
    if (!zip.file('word/document.xml')) throw new Error('no Word document inside');
    const doc = new Docxtemplater(zip, {
      delimiters: { start: '{{', end: '}}' },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => '',
      parser: (tag: string) => {
        found.add(tag.trim());
        return { get: (scope: Record<string, string>) => scope[tag.trim()] };
      },
    });
    return { zip, doc, found };
  } catch (e: any) {
    const why = e?.properties?.errors?.map((x: any) => x.properties?.explanation).filter(Boolean).join('; ') || e.message;
    throw new BadRequestException(`This is not a readable Word (.docx) template: ${why}`);
  }
}

// Refuses a template that is unreadable, uses unknown markers, or would make the server fetch something when converting.
export function checkTemplate(file: Buffer): void {
  const { zip, found } = open(file);
  const parts = (end: string) => Object.keys(zip.files).filter((n) => n.endsWith(end)).map((n) => zip.file(n)!.asText());
  const linked = parts('.rels')
    .flatMap((x) => x.match(/<(?:\w+:)?Relationship\b[^>]*>/g) ?? [])
    .some((r) => /TargetMode\s*=\s*["']External["']/.test(r) && !/Type\s*=\s*["'][^"']*\/hyperlink["']/.test(r));
  // ponytail: catches field codes written whole; one split across runs would pass. Only HR and the owner can upload.
  const outside = linked || parts('.xml').some((x) => /(INCLUDEPICTURE|INCLUDETEXT|DDEAUTO)\b/.test(x));
  if (outside) throw new BadRequestException('The template links to content outside the file (for example a linked picture). Embed it in the document and upload again.');
  const unknown = [...found].filter((m) => !(MARKERS as readonly string[]).includes(m));
  if (unknown.length) throw new BadRequestException(`Unknown marker(s): ${unknown.join(', ')}`);
}

export function fillTemplate(file: Buffer, values: MarkerValues): Buffer {
  const { doc } = open(file);
  doc.render(values);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
