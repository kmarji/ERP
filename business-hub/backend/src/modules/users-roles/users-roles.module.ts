import { BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcrypt';
import { IsDateString, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { actorHasRole, RequestUser } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() name!: string;
  @IsString() @MinLength(10) password!: string;
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

@ApiTags('users')
@ApiBearerAuth()
@Controller()
class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

@Module({ controllers: [UsersController] })
export class UsersRolesModule {}
