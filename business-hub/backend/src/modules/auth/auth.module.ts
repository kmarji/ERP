import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InviteController } from './invite.controller';
import { JwtStrategy } from './jwt.strategy';

@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        secret: c.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: c.get<string>('JWT_EXPIRES_IN') ?? '1h' },
      }),
    }),
  ],
  controllers: [AuthController, InviteController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
