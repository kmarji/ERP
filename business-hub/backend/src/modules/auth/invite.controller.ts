import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { IsString, MinLength } from 'class-validator';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { AuditService } from '../audit/audit.service';
import { Public } from './auth.decorators';

class AcceptInviteDto {
  @IsString() token!: string;
  @IsString() @MinLength(10) password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class InviteController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // One-time invite from onboarding: sets the first password. Every failure looks the same to the caller.
  @Public()
  @Throttle({ default: { limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10), ttl: 60_000 } })
  @HttpCode(200)
  @Post('accept-invite')
  async accept(@Body() dto: AcceptInviteDto) {
    const generic = new BadRequestException('Invalid or expired invitation');
    const invite = await this.prisma.raw.userInvite.findUnique({ where: { tokenHash: createHash('sha256').update(dto.token).digest('hex') } });
    if (!invite || invite.usedAt || invite.expiresAt < new Date()) throw generic;
    const passwordHash = await bcrypt.hash(dto.password, 10);
    return runWithTenant(invite.tenantId, async () => {
      // updateMany on usedAt IS NULL makes concurrent use of the same token succeed exactly once.
      const claimed = await this.prisma.db.userInvite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw generic;
      await this.prisma.db.user.updateMany({ where: { id: invite.userId }, data: { passwordHash } });
      await this.audit.record({ action: 'user.invite_accepted', entityType: 'User', entityId: invite.userId });
      return { accepted: true };
    });
  }
}
