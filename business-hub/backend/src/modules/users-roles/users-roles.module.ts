import { BadRequestException, ForbiddenException, Body, ConflictException, Controller, Delete, Get, Global, Module, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcrypt';
import { IsBoolean, IsDateString, IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DEFAULT_ROLES } from '../../common/roles';
import { assertRankBelowHr, invalidateOverrides, overridesFor } from '../../common/permissions';
import { AccessService } from './access.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() name!: string;
  @IsString() @MinLength(10) password!: string;
}

class NewRoleDto {
  @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @IsOptional() @IsInt() @Min(1) @Max(99) rank?: number;
}
class PermissionDto {
  @IsString() roleKey!: string;
  @IsString() area!: string;
  @IsOptional() @IsBoolean() allow?: boolean | null; // null/absent = back to the default
}

class AssignRoleDto {
  @IsString() roleKey!: string;
  @IsOptional() @IsString() legalEntityId?: string;
  @IsOptional() @IsString() branchId?: string;
}

class DelegationDto {
  @IsString() toUserId!: string;
  @IsString() roleKey!: string;
  @IsOptional() @IsString() branchId?: string;
  @IsDateString() startsAt!: string;
  @IsDateString() endsAt!: string;
}

// Granting or removing roles is a company-wide decision: branch-scoped HR/owner roles may not do it.
const assertCompanyWide = (a: RequestUser) => {
  if (!a.roles.some((r) => ['HR', 'OWNER'].includes(r.key) && r.branchId === null)) throw new ForbiddenException('Only company-wide HR or the owner can change roles');
};

@ApiTags('users')
@ApiBearerAuth()
@Controller()
class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  @Roles('OWNER', 'FINANCE', 'HR')
  @Get('users')
  list() {
    return this.prisma.db.user.findMany({
      select: { id: true, email: true, name: true, active: true, isSystem: true, roles: { include: { role: true } } },
    });
  }

  @Get('roles') roles() {
    return this.prisma.db.role.findMany({ orderBy: { rank: 'asc' } });
  }

  // Roles x modules. `allow` is the company's change; `defaults` is what the code gives.
  @Roles('OWNER', 'HR')
  @Get('roles/matrix')
  async matrix(@CurrentUser() actor: RequestUser) {
    const [roles, ov, counts] = await Promise.all([
      this.prisma.db.role.findMany({ where: { key: { not: 'SYSTEM' } }, orderBy: { rank: 'asc' } }),
      overridesFor(this.prisma, actor.tenantId),
      this.prisma.db.userRole.groupBy({ by: ['roleId'], _count: { _all: true } }),
    ]);
    return {
      roles: roles.map((r) => ({ key: r.key, name: r.name, rank: r.rank, custom: !DEFAULT_ROLES.some((d) => d.key === r.key), users: counts.find((c) => c.roleId === r.id)?._count._all ?? 0 })),
      areas: this.access.catalog(),
      overrides: [...ov].map(([k, allow]) => ({ roleKey: k.split('|')[0], area: k.split('|')[1], allow })),
    };
  }

  @Roles('OWNER')
  @Put('roles/permissions')
  async setPermission(@Body() dto: PermissionDto, @CurrentUser() actor: RequestUser) {
    const area = this.access.catalog().find((a) => a.area === dto.area);
    if (!area || area.locked) throw new BadRequestException('That module cannot be changed');
    if (dto.roleKey === 'OWNER' || dto.roleKey === 'SYSTEM') throw new BadRequestException('The owner and system roles are fixed');
    if (!(await this.prisma.db.role.findFirst({ where: { key: dto.roleKey } }))) throw new NotFoundException('Role not found');
    if (dto.allow == null) await this.prisma.db.rolePermission.deleteMany({ where: { roleKey: dto.roleKey, area: dto.area } });
    else await this.prisma.db.rolePermission.upsert({ where: { tenantId_roleKey_area: { tenantId: actor.tenantId, roleKey: dto.roleKey, area: dto.area } }, update: { allow: dto.allow, updatedBy: actor.id }, create: { tenantId: '', roleKey: dto.roleKey, area: dto.area, allow: dto.allow, updatedBy: actor.id } });
    invalidateOverrides(actor.tenantId);
    await this.audit.record({ action: 'role.permission_changed', entityType: 'Role', entityId: dto.roleKey, after: { area: dto.area, allow: dto.allow ?? 'default' } });
    return { ok: true };
  }

  @Roles('OWNER')
  @Post('roles')
  async createRole(@Body() dto: NewRoleDto) {
    const key = dto.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) throw new BadRequestException('Give the role a name');
    if (await this.prisma.db.role.findFirst({ where: { key } })) throw new ConflictException('A role with that name exists');
    const row = await this.prisma.db.role.create({ data: { tenantId: '', key, name: dto.name.trim(), rank: dto.rank ?? 20 } });
    await this.audit.record({ action: 'role.created', entityType: 'Role', entityId: row.id, after: { key, rank: row.rank } });
    return row;
  }

  @Roles('OWNER')
  @Delete('roles/:key')
  async deleteRole(@Param('key') key: string, @CurrentUser() actor: RequestUser) {
    if (DEFAULT_ROLES.some((d) => d.key === key)) throw new BadRequestException('Built-in roles cannot be deleted');
    const role = await this.prisma.db.role.findFirst({ where: { key } });
    if (!role) throw new NotFoundException('Role not found');
    if (await this.prisma.db.userRole.count({ where: { roleId: role.id } })) throw new ConflictException('Remove this role from its users first');
    await this.prisma.db.rolePermission.deleteMany({ where: { roleKey: key } });
    await this.prisma.db.role.deleteMany({ where: { id: role.id } });
    invalidateOverrides(actor.tenantId);
    await this.audit.record({ action: 'role.deleted', entityType: 'Role', entityId: role.id, after: { key } });
    return { deleted: true };
  }

  @Roles('OWNER', 'HR')
  @Post('users')
  async create(@Body() dto: CreateUserDto) {
    const user = await this.prisma.db.user.create({
      data: { tenantId: '', email: dto.email.toLowerCase(), name: dto.name, passwordHash: await bcrypt.hash(dto.password, 10) },
      select: { id: true, email: true, name: true },
    });
    await this.audit.record({ action: 'user.created', entityType: 'User', entityId: user.id, after: user });
    return user;
  }

  @Roles('OWNER', 'HR')
  @Post('users/:id/roles')
  async assign(@Param('id') id: string, @Body() dto: AssignRoleDto, @CurrentUser() actor: RequestUser) {
    assertCompanyWide(actor);
    if (id === actor.id && !actorHasRole(actor, 'OWNER')) throw new ForbiddenException('You cannot change your own roles');
    await assertRankBelowHr(this.prisma.db, actorHasRole(actor, 'OWNER'), [dto.roleKey]);
    // Separation of duties: nobody can grant the owner role unless they are an owner themselves.
    if (dto.roleKey === 'OWNER' && !actorHasRole(actor, 'OWNER')) throw new BadRequestException('Only an owner can grant OWNER');
    const [user, role] = await Promise.all([
      this.prisma.db.user.findFirst({ where: { id } }),
      this.prisma.db.role.findFirst({ where: { key: dto.roleKey } }),
    ]);
    if (!user || !role) throw new NotFoundException('User or role not found');
    const row = await this.prisma.db.userRole.create({
      data: { tenantId: '', userId: id, roleId: role.id, legalEntityId: dto.legalEntityId ?? null, branchId: dto.branchId ?? null },
    });
    await this.audit.record({ action: 'user.role_assigned', entityType: 'User', entityId: id, after: dto });
    return row;
  }

  @Roles('OWNER', 'HR')
  @Delete('users/:id/roles/:userRoleId')
  async unassign(@Param('id') id: string, @Param('userRoleId') urId: string, @CurrentUser() actor: RequestUser) {
    assertCompanyWide(actor);
    const ur = await this.prisma.db.userRole.findFirst({ where: { id: urId, userId: id }, include: { role: true } });
    if (!ur) throw new NotFoundException('Role assignment not found');
    await assertRankBelowHr(this.prisma.db, actorHasRole(actor, 'OWNER'), [ur.role.key]);
    if (ur.role.key === 'OWNER' && !actorHasRole(actor, 'OWNER')) throw new BadRequestException('Only an owner can remove OWNER');
    if (ur.role.key === 'OWNER' && id === actor.id) throw new BadRequestException('You cannot remove your own OWNER role');
    await this.prisma.db.userRole.deleteMany({ where: { id: urId } });
    await this.audit.record({ action: 'user.role_removed', entityType: 'User', entityId: id, after: { roleKey: ur.role.key, branchId: ur.branchId } });
    return { removed: true };
  }

  @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER')
  @Post('delegations')
  async delegate(@Body() dto: DelegationDto, @CurrentUser() actor: RequestUser) {
    // You can only delegate authority you hold, or authority ranked at or below your own highest role.
    const roles = await this.prisma.db.role.findMany();
    const rank = (k: string) => roles.find((r) => r.key === k)?.rank ?? Infinity;
    const myRank = Math.max(...actor.roles.map((r) => rank(r.key)), -1);
    if (!actorHasRole(actor, dto.roleKey, { branchId: dto.branchId }) && rank(dto.roleKey) > myRank) {
      throw new BadRequestException('Cannot delegate authority above your own role');
    }
    const row = await this.prisma.db.delegation.create({
      data: {
        tenantId: '',
        fromUserId: actor.id,
        toUserId: dto.toUserId,
        roleKey: dto.roleKey,
        branchId: dto.branchId ?? null,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
      },
    });
    await this.audit.record({ action: 'delegation.created', entityType: 'Delegation', entityId: row.id, after: row });
    return row;
  }

  @Roles('OWNER', 'FINANCE', 'BRANCH_MANAGER')
  @Post('delegations/:id/revoke')
  async revoke(@Param('id') id: string) {
    await this.prisma.db.delegation.updateMany({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record({ action: 'delegation.revoked', entityType: 'Delegation', entityId: id });
    return { revoked: true };
  }
}

@Global()
@Module({ controllers: [UsersController], providers: [AccessService], exports: [AccessService] })
export class UsersRolesModule {}
