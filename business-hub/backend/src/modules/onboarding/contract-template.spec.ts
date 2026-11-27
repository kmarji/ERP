import PizZip from 'pizzip';
import { checkTemplate } from './contract-template';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const rel = (id: string, type: string, target: string, mode = ' TargetMode="External"') => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${id}" Type="x/${type}" Target="${target}"${mode}/></Relationships>`;
function docx(body: string, files: Record<string, string | Buffer> = {}) {
  const z = new PizZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('word/document.xml', `<w:document ${W}><w:body><w:p>${body}</w:p></w:body></w:document>`);
  for (const [n, c] of Object.entries(files)) z.file(n, c);
  return z.generate({ type: 'nodebuffer' }) as Buffer;
}
const run = (x: string) => `<w:r>${x}</w:r>`;
const mark = (t: string) => run(`<w:fldChar w:fldCharType="${t}"/>`);
const instr = (t: string) => run(`<w:instrText xml:space="preserve">${t}</w:instrText>`);
const field = (...parts: string[]) => mark('begin') + parts.map(instr).join('') + mark('separate') + mark('end');
const URL = 'http://example.test/a';

describe('checkTemplate', () => {
  it('accepts ordinary documents: page numbers, a split harmless field and a web link', () => {
    expect(() => checkTemplate(docx(field(' PA', 'GE ') + `<w:fldSimple w:instr=" NUMPAGES "/>` + `<w:hyperlink r:id="h1">${run('<w:t>site</w:t>')}</w:hyperlink>`, { 'word/_rels/document.xml.rels': rel('h1', 'hyperlink', URL) }))).not.toThrow();
  });
  it.each([
    ['a field split across runs', docx(field(' INCLUDE', 'PICTURE "http://example.test/a" '))],
    ['a lower-case field', docx(field(' includetext "file:///etc/passwd" '))],
    ['a simple field', docx(`<w:fldSimple w:instr=" INCLUDETEXT &quot;file:///etc/passwd&quot; "/>`)],
    ['an encoded field name', docx(field('&#73;NCLUDETEXT "x"'))],
    ['an unlisted field', docx(field(' DATABASE '))],
    ['an instruction outside a field', docx(instr('INCLUDEPICTURE "x"'))],
    ['an encoded external relationship', docx('', { 'word/_rels/document.xml.rels': rel('r1', 'image', URL, ' TargetMode="&#69;xternal"') })],
    ['an address without TargetMode', docx('', { 'word/_rels/document.xml.rels': rel('r1', 'image', 'file:///etc/passwd', '') })],
    ['a hyperlink reused as a picture', docx(run('<w:drawing><a r:embed="h1"/></w:drawing>'), { 'word/_rels/document.xml.rels': rel('h1', 'hyperlink', URL) })],
    ['a direct picture address', docx(run(`<w:pict><imagedata src="${URL}"/></w:pict>`))],
    ['an embedded outside chunk', docx('<w:altChunk r:id="c1"/>')],
    ['a field in an oddly named part', docx('', { 'word/media/x.png': `<w:hdr ${W}><w:p>${field(' INCLUDETEXT "x" ')}</w:p></w:hdr>` })],
    ['a part in another encoding', docx('', { 'word/header1.xml': Buffer.from('\ufeff<a/>', 'utf16le') })],
    ['an OpenDocument file in disguise', docx('', { 'content.xml': '<a/>' })],
    ['a document type declaration', docx('', { 'word/header1.xml': '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>' })],
  ])('refuses %s', (_name, file) => expect(() => checkTemplate(file)).toThrow(/outside|not allowed|readable/));
});
