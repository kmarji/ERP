import { Global, Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { CoverageService } from './coverage.service';
import { LeaveService } from './leave.service';
import { SchedulesService } from './schedules.service';
import { TimeService } from './time.service';
import { SelfServiceController, WorkforceController } from './workforce.controller';

@Global()
@Module({
  controllers: [WorkforceController, SelfServiceController],
  providers: [AttendanceService, SchedulesService, TimeService, LeaveService, CoverageService],
  exports: [AttendanceService, LeaveService],
})
export class WorkforceModule {}
