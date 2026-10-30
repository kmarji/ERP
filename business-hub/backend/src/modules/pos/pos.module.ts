import { Module } from '@nestjs/common';
import { OfflineService } from './offline.service';
import { OrdersService } from './orders.service';
import { PosController } from './pos.controller';
import { PosReportsService } from './pos-reports.service';
import { PosTerminalAdapter, StubPosTerminal } from './pos.adapters';
import { OverrideService } from './override.service';
import { RefundsService } from './refunds.service';
import { SalesPostingService } from './sales-posting.service';
import { SettlementsService } from './settlements.service';
import { ShiftsService } from './shifts.service';
import { ConfigService } from '@nestjs/config';
import { requireStub } from '../integrations/adapter-mode';

@Module({
  controllers: [PosController],
  providers: [
    ShiftsService,
    OrdersService,
    RefundsService,
    SalesPostingService,
    OverrideService,
    OfflineService,
    SettlementsService,
    PosReportsService,
    {
      provide: PosTerminalAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        requireStub(c, 'POS_TERMINAL');
        return new StubPosTerminal();
      },
    },
  ],
  exports: [OrdersService, RefundsService, SalesPostingService, SettlementsService],
})
export class PosModule {}
