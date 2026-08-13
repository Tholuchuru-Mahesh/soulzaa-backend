import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { InvestigationRecordingController } from './controllers/investigation-recording.controller';
import { InvestigationRecordingService } from './services/investigation-recording.service';

@Module({
  imports: [PrismaModule],
  controllers: [InvestigationRecordingController],
  providers: [InvestigationRecordingService],
  exports: [InvestigationRecordingService],
})
export class InvestigationRecordingModule {}
