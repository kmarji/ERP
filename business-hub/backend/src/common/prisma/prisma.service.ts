import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { currentTenantId } from '../tenancy/tenant-context';

// Models that carry tenantId are discovered from the Prisma DMMF, so a new model is scoped automatically.
const SCOPED_MODELS = new Set(
  Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === 'tenantId')).map((m) => m.name),
);

const WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

// Callers pass tenantId: '' on creates (the type requires it); the extension always overwrites it from context.
function stamp(data: any, tenantId: string, model: string) {
  if (data && data.tenantId && data.tenantId !== tenantId) {
    throw new Error(`Cross-tenant write blocked on ${model}`);
  }
  return { ...data, tenantId };
}

// Finalized history is never rewritten; corrections are new rows. A DB trigger enforces the same for raw clients.
const IMMUTABLE_MODELS = new Set(['Journal', 'JournalLine', 'AuditEvent', 'StockMovement']);
const MUTATING_OPS = new Set(['update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

function buildScoped(client: PrismaClient) {
  return client.$extends({
    name: 'tenant-scoping',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (IMMUTABLE_MODELS.has(model) && MUTATING_OPS.has(operation)) {
            throw new Error(`${model} is append-only: ${operation} is not allowed`);
          }
          if (!SCOPED_MODELS.has(model)) return query(args);
          // Fail closed: a scoped model can never be touched without a tenant context.
          const tenantId = currentTenantId();
          const a: any = args ?? {};
          if (WHERE_OPS.has(operation)) {
            a.where = { ...(a.where ?? {}), tenantId };
          } else if (operation === 'create') {
            a.data = stamp(a.data, tenantId, model);
          } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
            a.data = Array.isArray(a.data)
              ? a.data.map((d: any) => stamp(d, tenantId, model))
              : stamp(a.data, tenantId, model);
          } else if (operation === 'upsert') {
            a.where = { ...(a.where ?? {}), tenantId };
            a.create = stamp(a.create, tenantId, model);
          }
          return query(a);
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof buildScoped>;
// Either the scoped client itself or a transaction client from $transaction.
export type ScopedTx = ScopedClient | Parameters<Parameters<ScopedClient['$transaction']>[0]>[0];

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  // Unscoped client: only for tenant-less bootstrap, login lookup and cross-tenant system sweeps.
  readonly raw = new PrismaClient();
  // Tenant-scoped client: use this everywhere else.
  readonly db: ScopedClient = buildScoped(this.raw);

  async onModuleInit() {
    await this.raw.$connect();
  }

  async onModuleDestroy() {
    await this.raw.$disconnect();
  }
}
