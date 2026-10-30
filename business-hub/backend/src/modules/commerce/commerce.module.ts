import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requireStub } from '../integrations/adapter-mode';
import { PosModule } from '../pos/pos.module';
import { AggregatorService } from './aggregator.service';
import { AggregatorAdapter, CustomerNotificationAdapter, PaymentGatewayAdapter, StubAggregatorAdapter, StubCustomerNotifier, StubPaymentGateway } from './commerce.adapters';
import { CommerceController } from './commerce.controller';
import { FulfilmentService } from './fulfilment.service';
import { StoreService } from './store.service';

@Module({
  imports: [PosModule],
  controllers: [CommerceController],
  providers: [
    StoreService,
    FulfilmentService,
    AggregatorService,
    StubAggregatorAdapter,
    StubCustomerNotifier,
    {
      provide: PaymentGatewayAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        requireStub(c, 'PAYMENT_GATEWAY');
        return new StubPaymentGateway();
      },
    },
    { provide: CustomerNotificationAdapter, useExisting: StubCustomerNotifier },
    {
      provide: AggregatorAdapter,
      inject: [ConfigService, StubAggregatorAdapter],
      useFactory: (c: ConfigService, stub: StubAggregatorAdapter) => {
        requireStub(c, 'AGGREGATOR');
        return stub;
      },
    },
  ],
  exports: [FulfilmentService],
})
export class CommerceModule {}
