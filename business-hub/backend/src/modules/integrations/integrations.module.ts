import { BullModule, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Controller, Get, Global, Module, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Job } from 'bullmq';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { Roles } from '../auth/auth.decorators';
import { ExceptionService } from '../workflow-engine/exception.service';
import { INTEGRATION_QUEUE, IntegrationHandlers, IntegrationsService } from './integrations.service';

@Processor(INTEGRATION_QUEUE)
class IntegrationProcessor extends WorkerHost {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly exceptions: ExceptionService,
  ) {
    super();
  }

  process(job: Job<{ jobId: string; tenantId: string }>) {
    return runWithTenant(job.data.tenantId, () => this.integrations.execute(job.data.jobId));
  }

  // Final failure: dead-letter the job and surface it as an exception for finance.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ jobId: string; tenantId: string }> | undefined, err: Error) {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await runWithTenant(job.data.tenantId, async () => {
      await this.integrations.markDead(job.data.jobId, err.message);
      await this.exceptions.raise({
        code: 'INTEGRATION_DEAD_LETTER',
        reason: `Integration job failed after ${job.attemptsMade} attempts: ${err.message}`,
        evidence: { integrationJobId: job.data.jobId },
        ownerRole: 'FINANCE',
        riskTier: 'MEDIUM',
        availableActions: ['retry', 'resolve'],
      });
    });
  }
}

@ApiTags('integrations')
@ApiBearerAuth()
@Roles('OWNER', 'FINANCE')
@Controller('integrations')
class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Get('jobs') jobs(@Query('status') status?: string) {
    return this.svc.list(status);
  }

  @Post('jobs/:id/retry') retry(@Param('id') id: string) {
    return this.svc.retry(id);
  }
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({
        connection: { host: c.get('REDIS_HOST') ?? 'localhost', port: Number(c.get('REDIS_PORT') ?? 6379), maxRetriesPerRequest: null },
      }),
    }),
    BullModule.registerQueue({ name: INTEGRATION_QUEUE }),
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationHandlers, IntegrationsService, IntegrationProcessor],
  exports: [IntegrationHandlers, IntegrationsService],
})
export class IntegrationsModule {}
