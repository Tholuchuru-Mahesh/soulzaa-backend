import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { WorkforceScopeModule } from 'src/modules/mobile-workforce/workforce-scope.module';
import { ModerationApprovalController } from './controllers/moderation-approval.controller';
import { ModerationApprovalService } from './services/moderation-approval.service';

@Module({
  imports: [PrismaModule, WorkforceScopeModule],
  controllers: [ModerationApprovalController],
  providers: [ModerationApprovalService],
  exports: [ModerationApprovalService],
})
export class ModerationApprovalModule {}
