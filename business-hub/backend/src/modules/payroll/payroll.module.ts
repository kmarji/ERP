import { Global, Module } from '@nestjs/common';
import { FieldCryptoModule } from '../../common/crypto/field-crypto';
import { PayrollController } from './payroll.controller';
import { PayrollRulesService } from './payroll-rules.service';
import { PayrollService } from './payroll.service';

@Global()
@Module({ imports: [FieldCryptoModule], controllers: [PayrollController], providers: [PayrollRulesService, PayrollService], exports: [PayrollRulesService, PayrollService] })
export class PayrollModule {}
