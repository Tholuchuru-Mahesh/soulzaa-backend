import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { OpsDashboardService } from './ops-dashboard.service';

@ApiTags('ops-dashboard')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('ops')
export class OpsDashboardController {
  constructor(private readonly opsService: OpsDashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Enterprise operations overview metrics' })
  getDashboard() {
    return this.opsService.getDashboardOverview();
  }

  @Get('readiness-report')
  @ApiOperation({ summary: 'Production deployment readiness audit report' })
  getReadinessReport() {
    return this.opsService.getProductionReadinessReport();
  }

  @Get('launch-readiness')
  @ApiOperation({ summary: 'Automated launch readiness audit report' })
  getLaunchReadiness() {
    return this.opsService.getLaunchReadinessReport();
  }

  @Get('executive-dashboard')
  @ApiOperation({ summary: 'Executive operational and business overview dashboard' })
  getExecutiveDashboard() {
    return this.opsService.getExecutiveDashboard();
  }

  @Get('slos')
  @ApiOperation({ summary: 'Service Level Objectives (SLO) compliance dashboard' })
  getSLODashboard() {
    return this.opsService.getSLODashboard();
  }

  @Get('launch-monitoring')
  @ApiOperation({ summary: 'Real-time launch day operational health monitoring' })
  getLaunchMonitoring() {
    return this.opsService.getLaunchMonitoring();
  }

  @Get('compliance')
  @ApiOperation({ summary: 'Security compliance audit report' })
  getCompliance() {
    return this.opsService.getComplianceReport();
  }

  @Get('certification')
  @ApiOperation({ summary: 'Global launch platform certification report' })
  getCertification() {
    return this.opsService.getGlobalLaunchCertification();
  }

  @Get('memory')
  @ApiOperation({ summary: 'Runtime memory usage and metrics' })
  getMemory() {
    return this.opsService.getMemoryMetrics();
  }

  @Get('recovery')
  @ApiOperation({ summary: 'Disaster recovery verification report' })
  getRecovery() {
    return this.opsService.getDisasterRecoveryService().runDisasterRecoveryVerification();
  }

  @Get('benchmark')
  @ApiOperation({ summary: 'Run high-concurrency performance benchmark' })
  runBenchmark(@Query('users') users?: string) {
    const numUsers = users ? parseInt(users, 10) : 1000;
    return this.opsService.getBenchmarkService().runBenchmark(numUsers);
  }

  @Get('exceptions')
  @ApiOperation({ summary: 'Enterprise exception analytics summary' })
  getExceptions() {
    return this.opsService.getExceptionAnalytics().getAnalytics();
  }

  @Get('database/performance')
  @ApiOperation({ summary: 'Database slow query performance report' })
  getDatabasePerformance() {
    return this.opsService.getPrismaPerformance().getPerformanceReport();
  }

  @Get('database/slow-queries')
  @ApiOperation({ summary: 'List detected database slow queries' })
  getSlowQueries() {
    return this.opsService.getPrismaPerformance().getSlowQueries();
  }

  @Get('database/statistics')
  @ApiOperation({ summary: 'Database query execution statistics' })
  getDatabaseStatistics() {
    return this.opsService.getPrismaPerformance().getDatabaseStatistics();
  }

  @Get('security')
  @ApiOperation({ summary: 'Security metrics and threat detection summary' })
  getSecurity() {
    return this.opsService.getSecurityAudit().getSecurityMetrics();
  }

  @Get('security/audit')
  @ApiOperation({ summary: 'Security posture audit report' })
  getSecurityAudit() {
    return this.opsService.getSecurityAudit().auditSecurityPosture();
  }

  @Get('stress')
  @ApiOperation({ summary: 'Run enterprise stress test scenario' })
  runStress(@Query('users') users?: string) {
    const numUsers = users ? parseInt(users, 10) : 1000;
    return this.opsService.getStressTest().runStressScenario(numUsers);
  }

  @Post('chaos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Simulate synthetic chaos failure recovery' })
  runChaos(@Query('service') service?: string) {
    const target = service ?? 'agora';
    return this.opsService.getChaosSimulation().runChaosSimulation(target);
  }

  @Get('dlq')
  @ApiOperation({ summary: 'List failed jobs in Dead Letter Queue' })
  getDLQJobs() {
    return this.opsService.getDLQService().listFailedJobs();
  }

  @Post('dlq/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry a failed DLQ job' })
  retryDLQJob(@Param('id') id: string) {
    return this.opsService.getDLQService().retryJob(id);
  }

  @Post('dlq/:id/replay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replay a DLQ job' })
  replayDLQJob(@Param('id') id: string) {
    return this.opsService.getDLQService().replayJob(id);
  }

  @Delete('dlq/:id')
  @ApiOperation({ summary: 'Purge a failed job from DLQ' })
  purgeDLQJob(@Param('id') id: string) {
    return this.opsService.getDLQService().purgeJob(id);
  }
}
