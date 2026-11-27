import { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import PizZip from 'pizzip';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { runWithTenant } from '../src/common/tenancy/tenant-context';
import { PdfConverter } from '../src/modules/onboarding/pdf';
import { WorkflowEngineService } from '../src/modules/workflow-engine/workflow-engine.service';
import { Http, auth, createApp, makeUser, newTenant, today } from './helpers';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
function docx(body: string, extra: { header?: string; rels?: string } = {}) {
  const z = new PizZip();
  const head = extra.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '';
  z.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${head}</Types>`);
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${para(body)}</w:body></w:document>`);
  if (extra.header) z.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${W}>${para(extra.header)}</w:hdr>`);
  if (extra.rels) z.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra.rels}</Relationships>`);
  return z.generate({ type: 'nodebuffer' }) as Buffer;
}

// Stands in for LibreOffice: the "PDF" is the filled document's text, so the test can read what was merged.
class FakeConverter {
  fail = false;
  async convert(input: Buffer) {
    if (this.fail) throw new Error('converter down');
    return Buffer.from('%PDF ' + new PizZip(input).file('word/document.xml')!.asText().replace(/<[^>]+>/g, ''));
  }
}

describe('M17 contract templates', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let T: Awaited<ReturnType<typeof newTenant>>;
  let hr: { id: string; token: string };
  let mgr: { id: string; token: string };
  let branchId: string, positionId: string;
  const converter = new FakeConverter();
  const post = (path: string, token: string, body: object = {}) => http.post(path).set(auth(token)).send(body);
  const send = (path: string, file: Buffer, fields: Record<string, string> = {}, name = 'contract.docx', token = hr.token, method: 'post' | 'put' = 'post') => {
    const r = http[method](path).set(auth(token));
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('file', file, { filename: name });
  };
  const bytes = (path: string, token?: string) => {
    const r = http.get(path).buffer(true).parse((res, done) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => done(null, Buffer.concat(c))); });
    return token ? r.set(auth(token)) : r;
  };

  async function advanced() {
    const suffix = randomUUID().slice(0, 6);
    const v = await prisma.raw.vacancy.create({ data: { tenantId: T.tenantId, number: `VAC-${suffix}`, branchId, legalEntityId: T.legalEntityId, positionId, headcount: 1, payMin: 400, payMax: 600, status: 'OPEN', publicCode: randomBytes(6).toString('hex'), requestedBy: hr.id } });
    const c = await prisma.raw.candidate.create({ data: { tenantId: T.tenantId, name: `Sara & <${suffix}>`, phone: `079${Math.floor(1000000 + Math.random() * 8999999)}`, dataConsentAt: new Date(), privacyNoticeVersion: 'v1', retentionUntil: new Date(Date.now() + 180 * 86_400_000) } });
    const a = await prisma.raw.application.create({ data: { tenantId: T.tenantId, vacancyId: v.id, candidateId: c.id, status: 'ADVANCED', trackingToken: randomBytes(18).toString('hex') } });
    await runWithTenant(T.tenantId, async () => {
      const engine = app.get(WorkflowEngineService);
      const wf = await engine.start('WF-03', 'Application', a.id);
      for (const ev of ['screen_pass', 'invite', 'scheduled', 'interview_done', 'auto_advance']) await engine.fire(wf.id, ev);
    });
    return { ...a, name: c.name };
  }
  const offerBody = (over: object = {}) => ({ startDate: today(), salaryBasic: 500, allowances: [{ name: 'Transport', amount: 30 }], ...over });
  const GOOD = docx('{{employee_name}} | {{ job_title }} | {{basic_salary}} | {{total_salary}} | {{allowances}} | {{nationality}}|end', { header: '{{offer_number}}' });

  beforeAll(async () => {
    ({ app, http, prisma } = await createApp((b) => b.overrideProvider(PdfConverter).useValue(converter)));
    T = await newTenant(http, 'm17');
    hr = await makeUser(http, T, 'hr', 'HR');
    branchId = (await post('/org/branches', T.token, { legalEntityId: T.legalEntityId, code: 'B1', name: 'Abdoun' }).expect(201)).body.id;
    mgr = await makeUser(http, T, 'mgr', 'BRANCH_MANAGER', branchId);
    positionId = (await prisma.raw.jobPosition.create({ data: { tenantId: T.tenantId, title: 'Cashier', titleAr: 'كاشير', payBandMin: 300, payBandMax: 600 } })).id;
  });
  afterAll(() => app.close());

  it('refuses files that are not safe, readable Word templates', async () => {
    const bad = async (file: Buffer, name = 'contract.docx') => (await send('/contract-templates', file, { name: 'Bad' }, name).expect(400)).body.message as string;
    await bad(Buffer.from('just text'));
    await bad(GOOD, 'contract.pdf');
    expect(await bad(docx('{{employe_name}} {{salary}}'))).toMatch(/employe_name.*salary/);
    expect(await bad(docx('ok', { header: '{{nope}}' }))).toMatch(/nope/);
    await bad(docx('{{employee_name'));
    expect(await bad(docx('x', { rels: '<Relationship Id="r9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://example.test/a.png" TargetMode="External"/>' }))).toMatch(/outside/);
    expect(await bad(docx('x', { rels: '<pr:Relationship xmlns:pr="x" Id="r9" Type="a/image" Target="http://example.test/a.png" TargetMode="External"/>' }))).toMatch(/outside/);
    expect(await bad(docx('</w:t></w:r><w:r><w:instrText>INCLUDEPICTURE "http://example.test/a.png"</w:instrText></w:r><w:r><w:t>'))).toMatch(/outside/);
    await send('/contract-templates', GOOD, { name: 'No' }, 'c.docx', mgr.token).expect(403);
    await send('/contract-templates', Buffer.alloc(6 * 1024 * 1024), { name: 'Big' }).expect(413);
  });

  it('fills an offer from a template, serves it as PDF, and keeps it when the template changes', async () => {
    const t = (await send('/contract-templates', GOOD, { name: 'Open contract', contractType: 'OPEN' }).expect(201)).body;
    expect(t).toMatchObject({ name: 'Open contract', contractType: 'OPEN', active: true });
    expect(t.storageKey).toBeUndefined();
    expect((await bytes(`/contract-templates/${t.id}/download`, hr.token).expect(200)).body.equals(GOOD)).toBe(true);

    const a = await advanced();
    await post(`/applications/${a.id}/offer`, hr.token, offerBody({ templateId: t.id, contractType: 'FIXED_TERM', endDate: '2027-12-31' })).expect(400); // wrong type
    converter.fail = true;
    await post(`/applications/${a.id}/offer`, hr.token, offerBody({ templateId: t.id })).expect(503);
    expect(await prisma.raw.offer.count({ where: { applicationId: a.id } })).toBe(0);
    converter.fail = false;
    const offer = (await post(`/applications/${a.id}/offer`, hr.token, offerBody({ templateId: t.id })).expect(201)).body;
    expect(offer).toMatchObject({ templateId: t.id, contractText: null });

    const pdf = await bytes(`/offers/${offer.id}/contract`, hr.token).expect(200);
    expect(pdf.headers['content-type']).toMatch('application/pdf');
    expect(pdf.body.toString()).toContain(`${a.name.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')} | Cashier | 500.000 | 530.000 | Transport: 30.000 JOD | |end`);
    await bytes(`/offers/${offer.id}/contract`, mgr.token).expect(403);

    await bytes(`/apply/status/${a.trackingToken}/offer/contract`).expect(404); // not sent yet
    await post(`/offers/${offer.id}/send`, hr.token).expect(201);
    expect((await http.get(`/apply/status/${a.trackingToken}/offer`).expect(200)).body).toMatchObject({ hasPdf: true, contractText: null });
    await send(`/contract-templates/${t.id}/file`, docx('changed {{employee_name}}'), {}, 'v2.docx', hr.token, 'put').expect(200);
    expect((await bytes(`/apply/status/${a.trackingToken}/offer/contract`).expect(200)).body.equals(pdf.body)).toBe(true);

    await http.patch(`/contract-templates/${t.id}`).set(auth(hr.token)).send({ active: false }).expect(200);
    await post(`/applications/${(await advanced()).id}/offer`, hr.token, offerBody({ templateId: t.id })).expect(400);
  });

  it('an offer without a template still uses the built-in text', async () => {
    const a = await advanced();
    const offer = (await post(`/applications/${a.id}/offer`, hr.token, offerBody()).expect(201)).body;
    expect(offer.contractText.en).toContain('Employment Contract');
  });
});
