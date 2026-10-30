import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adapterMode } from '../integrations/adapter-mode';
import { WorkflowRegistry } from '../workflow-engine/workflow.types';
import { ApplicationFlowService } from './application-flow.service';
import { ApplicationsService } from './applications.service';
import { CareersController } from './careers.controller';
import { EvaluationService } from './evaluation.service';
import { InterviewsService } from './interviews.service';
import { LlmAdapter, OpenRouterAssessor, StubRuleAssessor } from './llm.adapters';
import { RecruitmentController } from './recruitment.controller';
import { WF03_DEFINITION } from './recruitment.workflow';
import { RetentionService } from './retention.service';
import { RecruitmentSetupService } from './setup.service';
import { VacanciesService } from './vacancies.service';

@Module({
  controllers: [RecruitmentController, CareersController],
  providers: [
    RecruitmentSetupService,
    VacanciesService,
    ApplicationFlowService,
    EvaluationService,
    InterviewsService,
    ApplicationsService,
    RetentionService,
    {
      provide: LlmAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        const mode = adapterMode(c, 'LLM');
        if (mode === 'openrouter') return new OpenRouterAssessor(c);
        if (mode !== 'stub') throw new Error(`Unknown LLM_MODE '${mode}' (use 'stub' or 'openrouter')`);
        return new StubRuleAssessor();
      },
    },
  ],
  exports: [ApplicationFlowService],
})
export class RecruitmentModule implements OnModuleInit {
  constructor(private readonly registry: WorkflowRegistry) {}

  onModuleInit() {
    this.registry.register(WF03_DEFINITION);
  }
}
