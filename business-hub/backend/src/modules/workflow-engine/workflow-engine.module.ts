import { Body, Controller, Get, Global, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ExceptionStatus } from '@prisma/client';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { roleVisibility } from '../../common/tenancy/visibility';
import { CurrentUser } from '../auth/auth.decorators';
import { ApprovalService } from './approval.service';
import { ExceptionService } from './exception.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowRegistry } from './workflow.types';

const ACTIONS: Record<string, ExceptionStatus> = {
  resolve: 'RESOLVED',
  execute: 'EXECUTED',
  retry: 'RETRIED',
  verify: 'VERIFIED',
  archive: 'ARCHIVED',
};

class ExceptionActionDto {
  @IsIn(Object.keys(ACTIONS)) action!: string;
  @IsOptional() @IsString() comment?: string;
}

class DecideDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() comment?: string;
}

@ApiTags('workflow')
@ApiBearerAuth()
@Controller()
class WorkflowController {
  constructor(
    private readonly engine: WorkflowEngineService,
    private readonly exceptions: ExceptionService,
    private readonly approvals: ApprovalService,
    private readonly registry: WorkflowRegistry,
    private readonly prisma: PrismaService,
  ) {}

  @Get('workflows/definitions') definitions() {
    return this.registry.list();
  }

  @Get('workflows/:id') workflow(@Param('id') id: string) {
    return this.engine.get(id);
  }

  @Get('exceptions') listExceptions(@CurrentUser() u: RequestUser, @Query('status') status?: ExceptionStatus, @Query('open') open?: string) {
    return this.exceptions.list(u, { status, open: open === 'true' });
  }

  @Get('exceptions/:id') async exception(@CurrentUser() u: RequestUser, @Param('id') id: string) {
    await this.exceptions.assertVisible(u, id);
    return this.exceptions.get(id);
  }

  @Post('exceptions/:id/actions') async act(@CurrentUser() u: RequestUser, @Param('id') id: string, @Body() dto: ExceptionActionDto) {
    await this.exceptions.assertVisible(u, id);
    return this.exceptions.transition(id, ACTIONS[dto.action], dto.comment, u);
  }

  @Get('approvals') listApprovals(@CurrentUser() u: RequestUser, @Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
    return this.approvals.list(u, status);
  }

  @Post('approvals/:id/decide') decide(@CurrentUser() u: RequestUser, @Param('id') id: string, @Body() dto: DecideDto) {
    return this.approvals.decide(id, dto.approve, u, dto.comment);
  }

  @Get('tasks') tasks(@CurrentUser() u: RequestUser) {
    return this.prisma.db.task.findMany({
      where: { status: 'OPEN', OR: [{ assigneeUserId: u.id }, ...roleVisibility(u, 'assigneeRole')] },
      orderBy: { dueAt: 'asc' },
      take: 200,
    });
  }

  @Post('tasks/:id/complete') completeTask(@Param('id') id: string) {
    return this.prisma.db.task.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'DONE' } });
  }
}

@Global()
@Module({
  controllers: [WorkflowController],
  providers: [WorkflowRegistry, WorkflowEngineService, ExceptionService, ApprovalService],
  exports: [WorkflowRegistry, WorkflowEngineService, ExceptionService, ApprovalService],
})
export class WorkflowEngineModule {}
