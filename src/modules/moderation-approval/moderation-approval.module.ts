import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { ModerationApprovalController } from './controllers/moderation-approval.controller';
import { ModerationApprovalService } from './services/moderation-approval.service';

@Module({
  imports: [PrismaModule, MobileWorkforceModule],
  controllers: [ModerationApprovalController],
  providers: [ModerationApprovalService],
  exports: [ModerationApprovalService],
})
export class ModerationApprovalModule {}
