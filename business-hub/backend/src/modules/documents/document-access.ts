import { PrismaService } from '../../common/prisma/prisma.service';
import { isOwner, RequestUser } from '../../common/tenancy/tenant-context';

export interface DocRef { id: string; createdBy: string | null; subjectType: string | null; subjectId: string | null }
type Branch = string | null | undefined;

// A company-wide role always counts; a branch-limited one only for a record of its branch. Delegations count.
function holds(user: RequestUser, keys: string[], branches: Branch[] = []) {
  const roles = [...user.roles, ...user.delegations.map((d) => ({ key: d.roleKey, branchId: d.branchId }))];
  return roles.some((r) => (r.key === 'OWNER' || keys.includes(r.key)) && (r.branchId === null || branches.includes(r.branchId)));
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
  const staffBranch = async (employeeId: string) => (await db.employeeAssignment.findMany({ where: { employeeId, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })).map((a) => a.branchId);

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
      return branches.length > 0 && holds(user, OPS, branches);
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
      return holds(user, HR, rows.map((a) => a.vacancy.branchId));
    },

    // offer contracts, employment contracts, payslips, payroll and bank files
    async () => {
      const offers = await db.offer.findMany({ where: { OR: [{ contractDocId: id }, ...(subject('Offer') ? [{ id: subject('Offer')! }] : [])] } });
      if (offers.length && holds(user, PAY, offers.map((o) => o.branchId))) return true;
      const lines = await db.payrollRunLine.findMany({ where: { OR: [{ payslipDocId: id }, ...(subject('PayrollRunLine') ? [{ id: subject('PayrollRunLine')! }] : [])] } });
      if (lines.length && holds(user, PAY, lines.map((l) => l.branchId))) return true;
      const companyWide = subject('PayrollRun') || (await db.payrollRun.findFirst({ where: { bankFileDocId: id } })) || (await db.employmentContract.findFirst({ where: { documentId: id } }));
      return !!companyWide && holds(user, PAY);
    },

    // tax filing
    async () => !!(subject('TaxReturn') || (await db.taxReturn.findFirst({ where: { packageDocId: id } }))) && holds(user, ['FINANCE']),

    // leave certificates: HR, the employee and their line manager
    async () => {
      for (const leave of await db.leaveRequest.findMany({ where: { certificateDocId: id } })) {
        const employee = await db.employee.findFirst({ where: { id: leave.employeeId } });
        if (!employee) continue;
        if (employee.userId === user.id || holds(user, HR, await staffBranch(employee.id))) return true;
        if (employee.managerId && (await db.employee.findFirst({ where: { id: employee.managerId } }))?.userId === user.id) return true;
      }
      return false;
    },

    // discipline evidence
    async () => {
      for (const c of await db.disciplinaryCase.findMany({ where: { evidenceDocIds: { array_contains: [id] } } })) {
        if (holds(user, HR, await staffBranch(c.employeeId))) return true;
      }
      return false;
    },

    // supplier invoices and delivery evidence
    async () => {
      const invoices = await db.supplierInvoice.findMany({ where: { OR: [{ evidenceDocumentId: id }, ...(subject('SupplierInvoice') ? [{ id: subject('SupplierInvoice')! }] : [])] }, include: { receipts: true, purchaseOrder: true } });
      return invoices.length > 0 && holds(user, BUYING, invoices.flatMap((i) => [...i.receipts.map((r) => r.branchId), i.purchaseOrder?.branchId]));
    },
  ];

  for (const rule of rules) if (await rule()) return true;
  return false;
}
