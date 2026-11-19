import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { adapterMode } from '../integrations/adapter-mode';
import { ActionsService } from './actions.service';
import { AuditsController, MySafetyController, OpsOverviewController } from './audits.controller';
import { DashboardService } from './dashboard.service';
import { OpsSettings } from './ops-settings';
import { ReportsService } from './reports.service';
import { AuditsService } from './audits.service';
import { FoodSafetyService } from './food-safety.service';
import { LearningService } from './learning.service';
import { OpenRouterQuestionGen, QuestionGenAdapter, StubQuestionGen } from './question-gen';
import { ChecklistsService } from './checklists.service';
import { LearningController, MyChecklistsController, MyLearningController, OperationsController } from './operations.controller';

@Module({ controllers: [OperationsController, MyChecklistsController, LearningController, MyLearningController, AuditsController, MySafetyController, OpsOverviewController],
  providers: [
    ChecklistsService,
    LearningService,
    ActionsService,
    AuditsService,
    FoodSafetyService,
    DashboardService,
    ReportsService,
    OpsSettings,
    {
      provide: QuestionGenAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        const mode = adapterMode(c, 'LLM');
        if (mode === 'openrouter') return new OpenRouterQuestionGen(c);
        if (mode !== 'stub') throw new Error(`Unknown LLM_MODE '${mode}' (use 'stub' or 'openrouter')`);
        return new StubQuestionGen();
      },
    },
  ],
  exports: [LearningService],
})
export class OperationsModule {}
