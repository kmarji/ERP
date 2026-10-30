import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser, runWithTenant } from '../../common/tenancy/tenant-context';
import { loadRequestUser } from './request-user';

export interface JwtPayload {
  sub: string;
  tid: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  // Roles and delegations are read fresh each request so revocation takes effect immediately.
  async validate(payload: JwtPayload): Promise<RequestUser> {
    return runWithTenant(payload.tid, async () => {
      const user = await loadRequestUser(this.prisma, { id: payload.sub });
      if (!user) throw new UnauthorizedException();
      return user;
    });
  }
}
