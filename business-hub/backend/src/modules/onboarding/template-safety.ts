import { BadRequestException } from '@nestjs/common';
import { DOMParser } from '@xmldom/xmldom';
import PizZip from 'pizzip';

// LibreOffice opens uploaded templates on the server, so anything that could make it read a server file or call
// another address is refused. Parts are parsed as XML (so encodings and split text cannot hide anything) and
// fields are allowed by name only.
const SAFE_FIELDS = new Set(['PAGE', 'NUMPAGES', 'SECTION', 'SECTIONPAGES', 'DATE', 'TIME', 'TOC', 'PAGEREF', 'REF', 'NOTEREF', 'STYLEREF', 'SEQ', 'HYPERLINK', 'FORMTEXT', 'FORMCHECKBOX', 'FORMDROPDOWN']);
const ADDRESS = /^\s*([a-z][a-z0-9+.-]*:|\\\\)/i; // http:, file:, \\server

const refuse = (why: string): never => {
  throw new BadRequestException(`This is not allowed in a template: ${why}. Nothing may reach outside the document (linked pictures, included files, attached templates).`);
};
const unreadable = (name: string): never => {
  throw new BadRequestException(`This is not a readable Word (.docx) template: "${name}" is not plain UTF-8 XML`);
};

function parts(zip: PizZip) {
  return Object.values(zip.files).filter((f) => !f.dir).flatMap((f) => {
    const raw = f.asNodeBuffer();
    const xmlName = /\.(xml|rels)$/i.test(f.name);
    const utf16 = (raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff) || (raw[0] === 0 && raw[1] === 0x3c);
    const text = raw.toString('utf8').replace(/^﻿/, '');
    // Whatever its name, a part that looks like XML is checked as XML.
    if (!utf16 && !xmlName && !text.trimStart().startsWith('<')) return [];
    if (utf16 || text.includes('\0') || /^\s*<\?xml[^>]*encoding\s*=\s*["'](?!(utf-8|us-ascii)["'])/i.test(text)) unreadable(f.name);
    if (/<!DOCTYPE/i.test(text)) refuse('a document type declaration');
    let broken = false;
    let doc: any;
    try {
      doc = new DOMParser({ onError: (level: string) => { if (level !== 'warning') broken = true; } }).parseFromString(text, 'text/xml');
    } catch {
      broken = true;
    }
    if (broken) unreadable(f.name);
    return [{ name: f.name, elements: Array.from(doc.getElementsByTagName('*')) as any[] }];
  });
}

const local = (n: any): string => n.localName ?? n.nodeName.split(':').pop();
const attributes = (el: any) => (Array.from(el.attributes) as any[]).map((a) => ({ name: local(a), value: String(a.value) }));
const attr = (el: any, name: string) => attributes(el).find((a) => a.name === name)?.value ?? '';

function checkField(instruction: string) {
  const word = instruction.trim().split(/[\s\\"{]+/)[0].toUpperCase();
  if (!SAFE_FIELDS.has(word)) refuse(`the field "${word || '(unnamed)'}"`);
}

// A field's instruction can be split over many pieces between its "begin" and "separate" marks.
function checkFields(elements: any[]) {
  const open: { text: string; done: boolean }[] = [];
  for (const el of elements) {
    const kind = local(el);
    if (kind === 'altChunk') refuse('an embedded file');
    if (kind === 'fldSimple') checkField(attr(el, 'instr'));
    if (kind === 'instrText' || kind === 'delInstrText') {
      const field = open[open.length - 1];
      if (field && !field.done) field.text += el.textContent;
      else checkField(el.textContent);
    }
    if (kind !== 'fldChar') continue;
    const mark = attr(el, 'fldCharType');
    if (mark === 'begin') open.push({ text: '', done: false });
    const field = open[open.length - 1];
    if (field && mark !== 'begin' && !field.done) { checkField(field.text); field.done = true; }
    if (mark === 'end') open.pop();
  }
  for (const field of open) if (!field.done) checkField(field.text);
}

export function checkSafety(zip: PizZip): void {
  if (zip.file('mimetype') || zip.file('content.xml')) refuse('an OpenDocument file');
  const all = parts(zip);
  // Web links are the only thing allowed to point outside, and only as links.
  const links = new Map<string, Set<string>>(); // part name -> ids of its web links
  for (const part of all) {
    for (const el of part.elements.filter((e) => local(e) === 'Relationship')) {
      const target = attr(el, 'Target');
      const link = attr(el, 'Type').endsWith('/hyperlink');
      const external = attr(el, 'TargetMode').trim().toLowerCase() === 'external';
      if (!(external && link) && (external || ADDRESS.test(target))) refuse(`a link to "${target.slice(0, 80)}"`);
      if (external) {
        const owner = part.name.replace(/_rels\/([^/]*)\.rels$/i, '$1');
        links.set(owner, (links.get(owner) ?? new Set()).add(attr(el, 'Id')));
      }
    }
  }
  for (const part of all) {
    checkFields(part.elements);
    for (const el of part.elements) {
      for (const a of attributes(el)) {
        if ((a.name === 'src' || a.name === 'href') && ADDRESS.test(a.value)) refuse(`a direct address "${a.value.slice(0, 80)}"`);
        if ((a.name === 'embed' || a.name === 'link') && links.get(part.name)?.has(a.value)) refuse('a web link used as content');
      }
    }
  }
}
