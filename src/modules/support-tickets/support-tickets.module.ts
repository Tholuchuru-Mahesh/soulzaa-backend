import { Module } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationModule } from 'src/modules/authorization/authorization.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { NotificationModule } from 'src/modules/notification/notification.module';
import { SupportTicketController } from './controllers/support-ticket.controller';
import { SupportTicketGateway } from './gateway/support-ticket.gateway';
import { SupportTicketRoomJoinPolicy } from './listeners/support-ticket-room-join.policy';
import { SupportTicketFanoutService } from './services/support-ticket-fanout.service';
import { SupportTicketQueryService } from './services/support-ticket-query.service';
import { SupportTicketService } from './services/support-ticket.service';

@Module({
  imports: [MobileWorkforceModule, NotificationModule, AuthorizationModule],
  controllers: [SupportTicketController],
  providers: [
    SupportTicketService,
    SupportTicketQueryService,
    SupportTicketFanoutService,
    // Gateway for the /support namespace; the policy self-registers on init and
    // must stay listed here or ticket rooms become joinable by any logged-in user.
    SupportTicketGateway,
    SupportTicketRoomJoinPolicy,
    PrismaService,
  ],
  exports: [SupportTicketQueryService],
})
export class SupportTicketsModule {}
