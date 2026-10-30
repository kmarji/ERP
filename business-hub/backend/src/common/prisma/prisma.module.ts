import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SequenceService } from './sequence.service';

@Global()
@Module({ providers: [PrismaService, SequenceService], exports: [PrismaService, SequenceService] })
export class PrismaModule {}
