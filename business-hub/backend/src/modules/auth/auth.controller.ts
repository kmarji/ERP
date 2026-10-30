import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Public } from './auth.decorators';
import { AuthService } from './auth.service';

class LoginDto {
  @IsString() tenant!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  // Brute-force protection; tests raise the limit through LOGIN_RATE_LIMIT.
  @Throttle({ default: { limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10), ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.tenant, dto.email, dto.password);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return user;
  }
}
