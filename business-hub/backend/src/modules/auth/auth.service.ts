import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';

// Compared against when the user does not exist, so response time does not reveal valid emails.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(tenantSlug: string, email: string, password: string) {
    const tenant = await this.prisma.raw.tenant.findUnique({ where: { slug: tenantSlug } });
    const user = tenant?.active
      ? await runWithTenant(tenant.id, () =>
          this.prisma.db.user.findFirst({ where: { email: email.toLowerCase() } }),
        )
      : null;
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!tenant || !user || !user.active || user.isSystem || !ok) throw new UnauthorizedException('Invalid credentials');
    const accessToken = await this.jwt.signAsync({ sub: user.id, tid: tenant.id, email: user.email });
    return { accessToken, tokenType: 'Bearer' };
  }
}
