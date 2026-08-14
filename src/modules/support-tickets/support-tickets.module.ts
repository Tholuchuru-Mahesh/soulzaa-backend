import { Module } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { SupportTicketController } from './controllers/support-ticket.controller';
import { SupportTicketQueryService } from './services/support-ticket-query.service';
import { SupportTicketService } from './services/support-ticket.service';

@Module({
  imports: [MobileWorkforceModule],
  controllers: [SupportTicketController],
  providers: [SupportTicketService, SupportTicketQueryService, PrismaService],
  exports: [SupportTicketQueryService],
})
export class SupportTicketsModule {}
