import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { OffboardingService } from './offboarding.service';

class InitiateDto {
  @IsString() employeeId!: string;
  @IsIn(['RESIGNATION', 'TERMINATION', 'END_OF_CONTRACT', 'OTHER']) reason!: string;
  @IsDateString() noticeDate!: string;
  @IsDateString() lastWorkingDay!: string;
}
class ItemDto {
  @IsString() @MinLength(2) label!: string;
  @IsIn(['EARNING', 'DEDUCTION']) kind!: 'EARNING' | 'DEDUCTION';
  @IsNumber() @Min(0.001) amount!: number;
}
class SettlementDto {
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) extra?: ItemDto[];
}

const HR = ['OWNER', 'HR'];

@ApiTags('offboarding')
@ApiBearerAuth()
@Controller('offboarding')
export class OffboardingController {
  constructor(private readonly svc: OffboardingService) {}

  @Roles(...HR, 'FINANCE') @Get() list() { return this.svc.list(); }
  @Roles(...HR, 'FINANCE') @Get(':id') get(@Param('id') id: string) { return this.svc.get(id); }
  @Roles(...HR) @Post() initiate(@Body() dto: InitiateDto, @CurrentUser() u: RequestUser) { return this.svc.initiate(dto, u); }
  @Roles(...HR) @Post(':id/checklist/:key') tick(@Param('id') id: string, @Param('key') key: string, @CurrentUser() u: RequestUser) { return this.svc.tick(id, key, u); }
  @Roles(...HR) @Post(':id/settlement') settle(@Param('id') id: string, @Body() dto: SettlementDto) { return this.svc.calculateSettlement(id, dto.extra); }
  @Roles(...HR) @Post(':id/request-approval') approval(@Param('id') id: string) { return this.svc.requestApproval(id); }
  @Roles(...HR) @Post(':id/complete') complete(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.svc.complete(id, u); }
  @Roles(...HR) @Post(':id/cancel') cancel(@Param('id') id: string) { return this.svc.cancel(id); }
}
