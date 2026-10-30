import { ExecutionContext, ForbiddenException, Injectable, CanActivate, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { currentContext, RequestUser } from '../../common/tenancy/tenant-context';
import { IS_PUBLIC, ROLES_KEY } from './auth.decorators';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    return super.canActivate(ctx);
  }

  handleRequest<T = RequestUser>(err: any, user: T): T {
    if (err || !user) throw err || new UnauthorizedException();
    const store = currentContext();
    if (store) store.user = user as unknown as RequestUser;
    return user;
  }
}

// Declarative @Roles('FINANCE', 'OWNER'): passes if the actor holds any listed role (directly or by delegation).
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const user: RequestUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user) throw new UnauthorizedException();
    const ok = required.some(
      (k) => user.roles.some((r) => r.key === k) || user.delegations.some((d) => d.roleKey === k),
    );
    if (!ok) throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    return true;
  }
}
