import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { currentContext } from '../tenancy/tenant-context';

// Stripe-style Idempotency-Key for POSTs: same key + same payload replays the stored response;
// same key + different payload is rejected; a concurrent duplicate gets 409.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const key = req.headers['idempotency-key'] as string | undefined;
    if (req.method !== 'POST' || !key || !currentContext()) return next.handle();
    return from(this.run(req, res, key, next));
  }

  private async run(req: any, res: any, key: string, next: CallHandler) {
    if (key.length > 200) throw new UnprocessableEntityException('Idempotency-Key too long');
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`)
      .digest('hex');

    const existing = await this.prisma.db.idempotencyRequest.findFirst({ where: { key } });
    if (existing) return this.replay(existing, requestHash, res);

    try {
      await this.prisma.db.idempotencyRequest.create({
        data: { tenantId: '', key, method: req.method, path: req.originalUrl, requestHash },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.db.idempotencyRequest.findFirstOrThrow({ where: { key } });
        return this.replay(raced, requestHash, res);
      }
      throw e;
    }

    try {
      const body = await lastValueFrom(next.handle());
      await this.prisma.db.idempotencyRequest.updateMany({
        where: { key },
        data: { responseStatus: res.statusCode, responseBody: (body ?? null) as any },
      });
      return body;
    } catch (e) {
      // Failed requests are not cached, so the client can fix the problem and retry with the same key.
      await this.prisma.db.idempotencyRequest.deleteMany({ where: { key } });
      throw e;
    }
  }

  private replay(row: { requestHash: string; responseStatus: number | null; responseBody: unknown }, hash: string, res: any) {
    if (row.requestHash !== hash) throw new UnprocessableEntityException('Idempotency-Key was already used with a different request');
    if (row.responseStatus === null) throw new ConflictException('A request with this Idempotency-Key is still in progress');
    res.status(row.responseStatus);
    res.setHeader('Idempotent-Replay', 'true');
    return row.responseBody;
  }
}
