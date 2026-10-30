import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { runWithTenant } from './tenant-context';

// Opens the AsyncLocalStorage tenant context before any guard or handler runs.
// Invalid/missing tokens simply get no context; JwtAuthGuard rejects them on protected routes.
@Injectable()
export class TenancyMiddleware implements NestMiddleware {
  constructor(private readonly jwt: JwtService) {}

  use(req: any, _res: any, next: () => void) {
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
    req.correlationId = correlationId;
    const header: string | undefined = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = this.jwt.verify<{ tid: string }>(header.slice(7));
        if (payload.tid) {
          return runWithTenant(payload.tid, () => next(), undefined, correlationId);
        }
      } catch {
        // fall through without context
      }
    }
    next();
  }
}
