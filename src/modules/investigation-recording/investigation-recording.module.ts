import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { WorkforceScopeModule } from 'src/modules/mobile-workforce/workforce-scope.module';
import { InvestigationRecordingController } from './controllers/investigation-recording.controller';
import { InvestigationRecordingExpiryScheduler } from './services/investigation-recording-expiry.scheduler';
import { InvestigationRecordingService } from './services/investigation-recording.service';

@Module({
  imports: [PrismaModule, WorkforceScopeModule],
  controllers: [InvestigationRecordingController],
  providers: [InvestigationRecordingService, InvestigationRecordingExpiryScheduler],
  exports: [InvestigationRecordingService],
})
export class InvestigationRecordingModule {}
