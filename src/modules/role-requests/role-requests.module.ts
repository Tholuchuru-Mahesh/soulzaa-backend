import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RoleRequestController } from './controllers/role-request.controller';
import { RoleRequestRoutingService } from './services/role-request-routing.service';
import { RoleRequestService } from './services/role-request.service';

/**
 * Role approval chains — OFFICIAL → MANAGER → ADMIN, routed entirely on the
 * normalised Country → State → Region hierarchy.
 */
@Module({
  imports: [PrismaModule],
  controllers: [RoleRequestController],
  providers: [RoleRequestService, RoleRequestRoutingService],
  exports: [RoleRequestService, RoleRequestRoutingService],
})
export class RoleRequestsModule {}
