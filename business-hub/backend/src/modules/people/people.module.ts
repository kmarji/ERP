import { Body, Controller, Get, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { FieldCryptoModule } from '../../common/crypto/field-crypto';
import { RequestUser } from '../../common/tenancy/tenant-context';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { compactIban, IBAN } from '../../common/iban';
import { requireStub } from '../integrations/adapter-mode';
import { LearningService } from '../operations/learning.service';
import { OperationsModule } from '../operations/operations.module';
import { PeopleService } from './people.service';
import { LettersService } from './letters.service';
import { AccountsService } from './accounts.service';
import { SscAdapter, SscService, StubSscAdapter } from './ssc.service';
import { WorkPermitService } from './work-permit.service';

class PatchDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() managerId?: string | null;
  @ValidateIf((o) => o.nationality !== undefined) @IsString() @MinLength(2) @MaxLength(60) nationality?: string;
  @IsOptional() @IsBoolean() needsWorkPermit?: boolean;
  @IsOptional() @IsString() @MaxLength(60) workPermitNumber?: string | null;
  @IsOptional() @IsDateString() workPermitExpiry?: string | null;
}

// Omitted keeps the stored value, an empty string removes it.
class SensitiveDto {
  @ValidateIf((o) => o.nationalId !== undefined && o.nationalId !== '') @IsString() @MinLength(5) @MaxLength(30) nationalId?: string;
  @ValidateIf((o) => o.dateOfBirth !== undefined && o.dateOfBirth !== '') @IsDateString() dateOfBirth?: string;
  @ValidateIf((o) => o.address !== undefined) @IsString() @MaxLength(300) address?: string;
  @Transform(compactIban) @ValidateIf((o) => o.iban !== undefined && o.iban !== '') @IsString() @Matches(IBAN) iban?: string;
}

class PayrollRatesDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1) sscEmployeeRate?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1) sscEmployerRate?: number | null;
  @IsOptional() @IsString() sscRateNote?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1) incomeTaxRate?: number | null;
  @IsOptional() @IsString() incomeTaxRateNote?: string | null;
}

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsOptional() @IsString() roleKey?: string;
}
class NewEmployeeDto {
  @IsString() @MinLength(2) name!: string;
  @IsOptional() @IsString() nameAr?: string;
  @IsString() @MinLength(2) @MaxLength(60) nationality!: string;
  @IsOptional() @IsBoolean() needsWorkPermit?: boolean;
  @IsOptional() @IsString() @MaxLength(60) workPermitNumber?: string;
  @IsOptional() @IsDateString() workPermitExpiry?: string;
  @IsString() @MinLength(5) phone!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() legalEntityId!: string;
  @IsString() branchId!: string;
  @IsString() positionId!: string;
  @IsDateString() hireDate!: string;
  @IsOptional() @IsString() contractType?: string;
  @IsNumber() @Min(0) salaryBasic!: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AllowanceDto) allowances?: AllowanceDto[];
  @IsOptional() @IsNumber() @Min(1) weeklyHours?: number;
  @IsOptional() @IsString() managerId?: string;
  @IsOptional() @ValidateNested() @Type(() => LoginDto) login?: LoginDto;
}
class PasswordDto {
  @IsString() @MinLength(10) password!: string;
}

class LetterRequestDto {
  @IsIn(['SALARY', 'EMPLOYMENT']) kind!: 'SALARY' | 'EMPLOYMENT';
  @IsString() @MinLength(2) @MaxLength(200) addressee!: string;
  @IsOptional() @IsString() @MaxLength(300) purpose?: string;
}
class LetterDecideDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() note?: string;
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
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
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

// Training is always a library item with an exam (Training & SOPs); a bare title is no longer accepted.
class TrainingDto {
  @IsString() itemId!: string;
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

@Controller()
class LettersController {
  constructor(private readonly letters: LettersService) {}
  @Post('me/letters') request(@CurrentUser() u: RequestUser, @Body() dto: LetterRequestDto) { return this.letters.request(u, dto); }
  @Get('me/letters') mine(@CurrentUser() u: RequestUser) { return this.letters.mine(u); }
  @Get('me/letters/:id') one(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.letters.mineOne(id, u); }
  @Roles('HR', 'OWNER') @Get('letters') list(@CurrentUser() u: RequestUser, @Query('status') status?: string) { return this.letters.list(u, status); }
  @Roles('HR', 'OWNER') @Post('letters/:id/decide') decide(@Param('id') id: string, @Body() dto: LetterDecideDto, @CurrentUser() u: RequestUser) { return this.letters.decide(id, dto.approve, dto.note, u); }
}

@ApiTags('people')
@ApiBearerAuth()
@Controller()
class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly ssc: SscService,
    private readonly learning: LearningService,
    private readonly accounts: AccountsService,
  ) {}

  @Roles(...READ) @Get('employees') list(@CurrentUser() u: RequestUser, @Query('branchId') branchId?: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.people.list(u, { branchId, status, q });
  }

  @Roles(...READ) @Get('employees/:id') one(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.people.get(id, u);
  }

  @Roles(...HR) @Post('employees') createEmployee(@Body() dto: NewEmployeeDto, @CurrentUser() u: RequestUser) { return this.accounts.create(u, dto); }
  @Roles(...HR) @Get('employees/:id/access') access(@Param('id') id: string, @CurrentUser() u: RequestUser) { return this.accounts.access(id, u); }
  @Roles(...HR) @Post('employees/:id/login') createLogin(@Param('id') id: string, @Body() dto: LoginDto, @CurrentUser() u: RequestUser) { return this.accounts.createLogin(id, u, dto); }
  @Roles(...HR) @Post('employees/:id/password') resetPassword(@Param('id') id: string, @Body() dto: PasswordDto, @CurrentUser() u: RequestUser) { return this.accounts.resetPassword(id, u, dto.password); }

  @Roles(...HR) @Get('employees/:id/sensitive') sensitive(@Param('id') id: string, @CurrentUser() u: RequestUser) {
    return this.people.sensitive(id, u);
  }

  @Roles(...HR) @Put('employees/:id/sensitive') setSensitive(@Param('id') id: string, @Body() dto: SensitiveDto, @CurrentUser() u: RequestUser) {
    return this.people.setSensitive(id, u, dto);
  }

  @Roles(...HR) @Patch('employees/:id') patch(@Param('id') id: string, @Body() dto: PatchDto, @CurrentUser() u: RequestUser) {
    return this.people.patch(id, u, dto);
  }

  @Roles('HR', 'OWNER', 'FINANCE') @Patch('employees/:id/payroll-rates') payrollRates(@Param('id') id: string, @Body() dto: PayrollRatesDto, @CurrentUser() u: RequestUser) {
    return this.people.setPayrollRates(id, u, dto);
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

  @Roles(...HR) @Post('employees/:id/training') addTraining(@Param('id') id: string, @Body() dto: TrainingDto, @CurrentUser() u: RequestUser) {
    return this.learning.assign({ employeeId: id, itemId: dto.itemId, dueDate: dto.dueDate }, u);
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
  imports: [FieldCryptoModule, OperationsModule],
  controllers: [PeopleController, LettersController],
  providers: [
    PeopleService,
    AccountsService,
    LettersService,
    SscService,
    WorkPermitService,
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
