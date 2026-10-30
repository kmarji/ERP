import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.decorators';
import { AuditService } from './audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@Roles('OWNER', 'FINANCE')
@Controller('audit')
class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.audit.list({ entityType, entityId, action, take: take ? +take : undefined, skip: skip ? +skip : undefined });
  }
}

@Global()
@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
