import { Module } from '@nestjs/common';
import { OffboardingController } from './offboarding.controller';
import { OffboardingService } from './offboarding.service';

@Module({ controllers: [OffboardingController], providers: [OffboardingService] })
export class OffboardingModule {}
