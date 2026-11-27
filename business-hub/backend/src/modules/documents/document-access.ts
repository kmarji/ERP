import { PrismaService } from '../../common/prisma/prisma.service';
import { isOwner, RequestUser } from '../../common/tenancy/tenant-context';

export interface DocRef { id: string; createdBy: string | null; subjectType: string | null; subjectId: string | null }
// Where a record sits. A role limited to a branch or legal entity counts only for a record inside that limit.
type Scope = { branchId?: string | null; legalEntityId?: string | null };

// Delegations count (they carry a branch limit only). A record with no known place needs an unlimited role.
function holds(user: RequestUser, keys: string[], scopes: Scope[]) {
  const roles = [...user.roles, ...user.delegations.map((d) => ({ key: d.roleKey, branchId: d.branchId, legalEntityId: null }))];
  const places = scopes.length ? scopes : [{}];
  return roles.some((r) => (r.key === 'OWNER' || keys.includes(r.key))
    && places.some((p: Scope) => (r.branchId === null || r.branchId === p.branchId) && (r.legalEntityId === null || r.legalEntityId === p.legalEntityId)));
}

const HR = ['HR'];
const PAY = ['HR', 'FINANCE'];
const OPS = ['HR', 'BRANCH_MANAGER'];
const BUYING = ['FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER'];

// Who may open a stored file: the owner, its uploader, or someone the record it belongs to allows.
// See docs/superpowers/specs/2026-11-27-document-access-design.md. A file nothing links to stays private.
export async function canReadDocument(prisma: PrismaService, user: RequestUser, doc: DocRef): Promise<boolean> {
  if (isOwner(user) || doc.createdBy === user.id) return true;
  const db = prisma.db;
  const id = doc.id;
  const subject = (type: string) => (doc.subjectType === type ? doc.subjectId : null);
  // Records of these branches, each with the branch's legal entity.
  const atBranches = async (ids: (string | null | undefined)[]): Promise<Scope[]> => (await db.branch.findMany({ where: { id: { in: ids.filter((x): x is string => !!x) } } })).map((b) => ({ branchId: b.id, legalEntityId: b.legalEntityId }));
  const ofEmployee = async (employeeId: string): Promise<Scope[]> => {
    const legalEntityId = (await db.employee.findFirst({ where: { id: employeeId } }))?.legalEntityId;
    const branches = (await db.employeeAssignment.findMany({ where: { employeeId, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.branchId);
    return branches.length ? branches.map((branchId) => ({ branchId, legalEntityId })) : [{ legalEntityId }];
  };

  const rules: (() => Promise<boolean>)[] = [
    // checklist and training guides: any signed-in member of staff
    async () => !!(await db.checklistTemplate.findFirst({ where: { attachments: { array_contains: [{ id }] } } }))
      || !!(await db.libraryItem.findFirst({ where: { OR: [{ docId: id }, { attachments: { array_contains: [{ id }] } }] } })),

    // branch proof
    async () => {
      const branches = [
        ...(await db.checklistRun.findMany({ where: { results: { array_contains: [{ docId: id }] } } })),
        ...(await db.auditRecord.findMany({ where: { results: { array_contains: [{ docId: id }] } } })),
        ...(await db.foodSafetyReading.findMany({ where: { docId: id } })),
        ...(await db.correctiveAction.findMany({ where: { evidenceDocIds: { array_contains: [id] } } })),
      ].map((r) => r.branchId);
      return branches.length > 0 && holds(user, OPS, await atBranches(branches));
    },

    // candidate documents and interview recordings
    async () => {
      const applications = [
        subject('Application'),
        ...(await db.applicationDocument.findMany({ where: { evidenceDocumentId: id } })).map((d) => d.applicationId),
        ...(await db.interview.findMany({ where: { OR: [{ recordingDocId: id }, ...(subject('Interview') ? [{ id: subject('Interview')! }] : [])] } })).map((i) => i.applicationId),
      ].filter((x): x is string => !!x);
      if (!applications.length) return false;
      const rows = await db.application.findMany({ where: { id: { in: applications } }, include: { vacancy: true } });
      return holds(user, HR, rows.map((a) => ({ branchId: a.vacancy.branchId, legalEntityId: a.vacancy.legalEntityId })));
    },

    // offer contracts, employment contracts, payslips, payroll and bank files
    async () => {
      const offers = await db.offer.findMany({ where: { OR: [{ contractDocId: id }, ...(subject('Offer') ? [{ id: subject('Offer')! }] : [])] } });
      if (offers.length && holds(user, PAY, await atBranches(offers.map((o) => o.branchId)))) return true;
      const lines = await db.payrollRunLine.findMany({ where: { OR: [{ payslipDocId: id }, ...(subject('PayrollRunLine') ? [{ id: subject('PayrollRunLine')! }] : [])] }, include: { run: true } });
      if (lines.length && holds(user, PAY, lines.map((l) => ({ branchId: l.branchId, legalEntityId: l.run.legalEntityId })))) return true;
      const runs = await db.payrollRun.findMany({ where: { OR: [{ bankFileDocId: id }, ...(subject('PayrollRun') ? [{ id: subject('PayrollRun')! }] : [])] } });
      if ((runs.length || subject('PayrollRun')) && holds(user, PAY, runs.map((r) => ({ legalEntityId: r.legalEntityId })))) return true;
      for (const c of await db.employmentContract.findMany({ where: { documentId: id } })) {
        // company-wide roles only (no branch), within the employee's legal entity
        const legalEntityId = (await db.employee.findFirst({ where: { id: c.employeeId } }))?.legalEntityId;
        if (holds(user, PAY, [{ legalEntityId }])) return true;
      }
      return false;
    },

    // tax filing
    async () => {
      const returns = await db.taxReturn.findMany({ where: { OR: [{ packageDocId: id }, ...(subject('TaxReturn') ? [{ id: subject('TaxReturn')! }] : [])] } });
      return (returns.length > 0 || !!subject('TaxReturn')) && holds(user, ['FINANCE'], returns.map((r) => ({ legalEntityId: r.legalEntityId })));
    },

    // leave certificates: HR, the employee and their line manager
    async () => {
      for (const leave of await db.leaveRequest.findMany({ where: { certificateDocId: id } })) {
        const employee = await db.employee.findFirst({ where: { id: leave.employeeId } });
        if (!employee) continue;
        if (employee.userId === user.id || holds(user, HR, await ofEmployee(employee.id))) return true;
        if (employee.managerId && (await db.employee.findFirst({ where: { id: employee.managerId } }))?.userId === user.id) return true;
      }
      return false;
    },

    // discipline evidence
    async () => {
      for (const c of await db.disciplinaryCase.findMany({ where: { evidenceDocIds: { array_contains: [id] } } })) {
        if (holds(user, HR, await ofEmployee(c.employeeId))) return true;
      }
      return false;
    },

    // supplier invoices and delivery evidence
    async () => {
      const invoices = await db.supplierInvoice.findMany({ where: { OR: [{ evidenceDocumentId: id }, ...(subject('SupplierInvoice') ? [{ id: subject('SupplierInvoice')! }] : [])] }, include: { receipts: true, purchaseOrder: true } });
      return invoices.length > 0 && holds(user, BUYING, await atBranches(invoices.flatMap((i) => [...i.receipts.map((r) => r.branchId), i.purchaseOrder?.branchId])));
    },
  ];

  for (const rule of rules) if (await rule()) return true;
  return false;
}
