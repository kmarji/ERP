import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { RequestUser } from '../../common/tenancy/tenant-context';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): RequestUser => ctx.switchToHttp().getRequest().user,
);
