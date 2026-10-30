import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { PrismaModule } from './common/prisma/prisma.module';
import { TenancyMiddleware } from './common/tenancy/tenancy.middleware';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuditModule } from './modules/audit/audit.module';
import { JwtAuthGuard, RolesGuard } from './modules/auth/auth.guards';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FinanceModule } from './modules/finance/finance.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CandidateNotifierModule } from './modules/recruitment/candidate-notifier';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OffboardingModule } from './modules/offboarding/offboarding.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { PeopleModule } from './modules/people/people.module';
import { RecruitmentModule } from './modules/recruitment/recruitment.module';
import { CommerceModule } from './modules/commerce/commerce.module';
import { CustomersModule } from './modules/customers/customers.module';
import { FloorModule } from './modules/floor/floor.module';
import { KdsModule } from './modules/kds/kds.module';
import { MenuModule } from './modules/menu/menu.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PolicyEngineModule } from './modules/policy-engine/policy-engine.module';
import { PosModule } from './modules/pos/pos.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { ReceivingModule } from './modules/receiving/receiving.module';
import { ReplenishmentModule } from './modules/replenishment/replenishment.module';
import { TaxModule } from './modules/tax/tax.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { UsersRolesModule } from './modules/users-roles/users-roles.module';
import { WorkforceModule } from './modules/workforce/workforce.module';
import { WorkflowEngineModule } from './modules/workflow-engine/workflow-engine.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot({ maxListeners: 50 }),
    ScheduleModule.forRoot(),
    // Rate limits protect public endpoints; THROTTLE_DISABLED=1 is for automated tests only.
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 600 }], skipIf: () => process.env.THROTTLE_DISABLED === '1' }),
    PrismaModule,
    AuthModule,
    TenancyModule,
    UsersRolesModule,
    AuditModule,
    PolicyEngineModule,
    NotificationsModule,
    WorkflowEngineModule,
    DocumentsModule,
    IntegrationsModule,
    DashboardModule,
    FinanceModule,
    CatalogModule,
    InventoryModule,
    PurchasingModule,
    ReceivingModule,
    TaxModule,
    ReplenishmentModule,
    MenuModule,
    KdsModule,
    CustomersModule,
    FloorModule,
    PosModule,
    CommerceModule,
    CandidateNotifierModule,
    RecruitmentModule,
    OnboardingModule,
    PeopleModule,
    WorkforceModule,
    PayrollModule,
    OffboardingModule,
  ],
  providers: [
    // Guard order: throttle, authenticate (JWT), then role check.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenancyMiddleware).forRoutes('*');
  }
}
