import { Module } from '@nestjs/common';
import { DisciplineController, MyWarningsController } from './discipline.controller';
import { DisciplineService } from './discipline.service';

@Module({ controllers: [DisciplineController, MyWarningsController], providers: [DisciplineService] })
export class DisciplineModule {}
