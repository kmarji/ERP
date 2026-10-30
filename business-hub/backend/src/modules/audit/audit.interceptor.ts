import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { currentContext } from '../../common/tenancy/tenant-context';
import { AuditService } from './audit.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Async trail for every mutating HTTP call. Compliance-critical writes also audit synchronously in their own transaction.
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly log = new Logger(AuditInterceptor.name);

  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if (!MUTATING.has(req.method) || !currentContext()) return next.handle();
    const action = `${req.method} ${req.route?.path ?? req.url}`;
    const record = (outcome: string) =>
      this.audit
        .record({ action: `http:${action}`, entityType: 'http', entityId: req.params?.id ?? null, outcome })
        .catch((e) => this.log.warn(`audit write failed: ${e.message}`));
    return next.handle().pipe(
      tap({
        next: () => void record('SUCCESS'),
        error: () => void record('FAILURE'),
      }),
    );
  }
}
