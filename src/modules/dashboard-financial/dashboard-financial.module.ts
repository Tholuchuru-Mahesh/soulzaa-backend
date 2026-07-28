import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { DashboardFinancialController } from './controllers/dashboard-financial.controller';
import { DashboardFinancialService } from './services/dashboard-financial.service';

/**
 * Financial section of the web admin console: financial overview, wallets,
 * treasury, revenue, withdrawals, agency and coin-seller settlements.
 *
 * Read-only aggregation over the finance engines — it introduces no business
 * logic of its own, per the Phase 21 non-goals.
 */
@Module({
  imports: [PrismaModule],
  controllers: [DashboardFinancialController],
  providers: [DashboardFinancialService],
  exports: [DashboardFinancialService],
})
export class DashboardFinancialModule {}
