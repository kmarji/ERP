import { Body, Controller, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEmail, IsInt, IsNumber, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { FieldCryptoModule } from '../../common/crypto/field-crypto';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { requireStub } from '../integrations/adapter-mode';
import { PeopleService } from './people.service';
import { SscAdapter, SscService, StubSscAdapter } from './ssc.service';

class PatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
}

class AssignDto {
  @IsString() branchId!: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsDateString() validFrom!: string;
  @IsOptional() @IsDateString() validTo?: string;
}

class EndDto {
  @IsOptional() @IsDateString() validTo?: string;
}

class AllowanceDto {
  @IsString() name!: string;
  @IsNumber() @Min(0) amount!: number;
}

class ContractDto {
  @IsDateString() effectiveDate!: string;
  @IsOptional() @IsString() type?: string;
  @IsNumber() @Min(0) salaryBasic!: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllowanceDto) allowances?: AllowanceDto[];
  @IsOptional() @IsNumber() @Min(1) weeklyHours?: number;
  @IsOptional() @IsInt() @Min(0) probationMonths?: number;
  @IsOptional() @IsDateString() endDate?: string;
}

class TrainingDto {
  @IsString() @MinLength(2) title!: string;
  @IsOptional() @IsBoolean() mandatory?: boolean;
  @IsOptional() @IsDateString() dueDate?: string;
}

class SubmissionDto {
  @IsString() @MinLength(2) reference!: string;
  @IsOptional() @IsDateString() submittedAt?: string;
}

class ConfirmDto {
  @IsOptional() @IsString() reference?: string;
}

class FailDto {
  @IsString() @MinLength(3) notes!: string;
}

const HR = ['HR', 'OWNER'];
const READ = ['HR', 'OWNER', 'FINANCE', 'BRANCH_MANAGER'];

@ApiTags('people')
@ApiBearerAuth()
@Controller()
class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly ssc: SscService,
  ) {}

  @Roles(...READ) @Get('employees') list(@CurrentUser() u: RequestUser, @Query('branchId') branchId?: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.people.list(u, { branchId, status, q });
  }

  @Roles(...READ) @Get('employees/:id') one(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.people.get(id, u);
  }

  @Roles(...HR) @Get('employees/:id/sensitive') sensitive(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.people.sensitive(id, u);
  }

  @Roles(...HR) @Patch('employees/:id') patch(@Param('id') id: string, @Body() dto: PatchDto) {
    return this.people.patch(id, dto);
  }

  @Roles(...HR) @Post('employees/:id/assignments') assign(@Param('id') id: string, @Body() dto: AssignDto) {
    return this.people.addAssignment(id, dto);
  }

  @Roles(...HR) @Post('employees/:id/assignments/:aid/end') endAssignment(@Param('id') id: string, @Param('aid') aid: string, @Body() dto: EndDto) {
    return this.people.endAssignment(id, aid, dto.validTo);
  }

  @Roles('HR', 'OWNER', 'FINANCE') @Get('employees/:id/contracts') contracts(@Param('id') id: string) {
    return this.people.contracts(id);
  }

  @Roles(...HR) @Post('employees/:id/contracts') newContract(@Param('id') id: string, @Body() dto: ContractDto, @CurrentUser() u: RequestUser) {
    return this.people.newContract(id, dto, u);
  }

  @Roles(...READ, 'EMPLOYEE') @Get('employees/:id/training') training(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.people.training(id, u);
  }

  @Roles(...HR) @Post('employees/:id/training') addTraining(@Param('id') id: string, @Body() dto: TrainingDto) {
    return this.people.addTraining(id, dto);
  }

  @Roles(...HR, 'EMPLOYEE') @Post('training/:id/complete') completeTraining(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.people.completeTraining(id, u);
  }

  // ---------------------------------------------------------------- social security lifecycle
  @Roles(...HR) @Get('ssc/actions') sscList(@Query('status') status?: string) {
    return this.ssc.list(status);
  }

  @Roles(...HR) @Get('ssc/actions/:id') sscOne(@Param('id') id: string) {
    return this.ssc.get(id);
  }

  @Roles(...HR) @Post('ssc/actions/:id/package') sscPackage(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.ssc.guidedPackage(id, u);
  }

  @Roles(...HR) @Post('ssc/actions/:id/record-submission') sscSubmit(@Param('id') id: string, @Body() dto: SubmissionDto, @CurrentUser() u: RequestUser) {
    return this.ssc.recordSubmission(id, dto, u);
  }

  @Roles(...HR) @Post('ssc/actions/:id/confirm') sscConfirm(@Param('id') id: string, @Body() dto: ConfirmDto, @CurrentUser() u: RequestUser) {
    return this.ssc.confirm(id, dto, u);
  }

  @Roles(...HR) @Post('ssc/actions/:id/fail') sscFail(@Param('id') id: string, @Body() dto: FailDto) {
    return this.ssc.fail(id, dto);
  }
}

@Module({
  imports: [FieldCryptoModule],
  controllers: [PeopleController],
  providers: [
    PeopleService,
    SscService,
    {
      provide: SscAdapter,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        requireStub(c, 'SSC');
        return new StubSscAdapter();
      },
    },
  ],
  exports: [PeopleService, SscService],
})
export class PeopleModule {}
