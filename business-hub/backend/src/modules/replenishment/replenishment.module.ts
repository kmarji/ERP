import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { ReplenishmentService } from './replenishment.service';

class RuleDto {
  @IsString() productId!: string;
  @IsString() locationId!: string;
  @IsNumber() @Min(0) minQtyBase!: number;
  @IsNumber() @Min(0) maxQtyBase!: number;
  @IsOptional() @IsInt() @Min(0) leadTimeDays?: number;
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() orderUnit?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@ApiTags('replenishment')
@ApiBearerAuth()
@Roles('OWNER', 'FINANCE', 'PROCUREMENT', 'BRANCH_MANAGER')
@Controller('replenishment')
class ReplenishmentController {
  constructor(private readonly svc: ReplenishmentService) {}

  @Get('rules') rules() {
    return this.svc.listRules();
  }

  @Post('rules') upsert(@Body() dto: RuleDto) {
    return this.svc.upsertRule(dto);
  }

  @Get('suggestions') suggestions() {
    return this.svc.suggestions();
  }

  @Post('run') run(@Query('dryRun') dryRun?: string) {
    return this.svc.run({ dryRun: dryRun === 'true' });
  }
}

@Module({ imports: [PurchasingModule], controllers: [ReplenishmentController], providers: [ReplenishmentService], exports: [ReplenishmentService] })
export class ReplenishmentModule {}
