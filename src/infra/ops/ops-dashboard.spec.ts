import { Test, TestingModule } from '@nestjs/testing';
import { ChaosSimulationService } from './chaos-simulation.service';
import { DisasterRecoveryService } from './disaster-recovery.service';
import { OpsDashboardController } from './ops-dashboard.controller';
import { OpsDashboardService } from './ops-dashboard.service';
import { PerformanceBenchmarkService } from './performance-benchmark.service';
import { StressTestService } from './stress-test.service';
import { ExceptionAnalyticsService } from '../observability/exception-analytics.service';
import { PrismaPerformanceService } from '../prisma/prisma-performance.service';
import { PrismaService } from '../prisma/prisma.service';
import { DLQService } from '../queue/dlq.service';
import { SecurityAuditService } from '../security/security-audit.service';

describe('OpsDashboard', () => {
  let controller: OpsDashboardController;
  let dlqServiceMock: any;
  let drServiceMock: any;
  let benchmarkServiceMock: any;

  beforeEach(async () => {
    dlqServiceMock = {
      listFailedJobs: jest.fn().mockResolvedValue([]),
      retryJob: jest.fn().mockResolvedValue(true),
      replayJob: jest.fn().mockResolvedValue(true),
      deleteJob: jest.fn().mockResolvedValue(true),
    };

    drServiceMock = {
      runDisasterRecoveryVerification: jest.fn().mockResolvedValue({ readinessScore: 100 }),
    };

    benchmarkServiceMock = {
      runBenchmark: jest.fn().mockResolvedValue({ throughputOpsPerSec: 1000 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpsDashboardController],
      providers: [
        OpsDashboardService,
        {
          provide: PrismaService,
          useValue: {
            user: { count: jest.fn().mockResolvedValue(100) },
            videoRoom: { count: jest.fn().mockResolvedValue(5) },
            audioRoom: { count: jest.fn().mockResolvedValue(3) },
            walletTransaction: { count: jest.fn().mockResolvedValue(50) },
          },
        },
        { provide: DLQService, useValue: dlqServiceMock },
        { provide: DisasterRecoveryService, useValue: drServiceMock },
        { provide: PerformanceBenchmarkService, useValue: benchmarkServiceMock },
        ExceptionAnalyticsService,
        PrismaPerformanceService,
        SecurityAuditService,
        StressTestService,
        {
          provide: ChaosSimulationService,
          useValue: { runChaosSimulation: jest.fn().mockResolvedValue({ recovered: true }) },
        },
      ],
    }).compile();

    controller = module.get<OpsDashboardController>(OpsDashboardController);
  });

  it('should return ops dashboard data', async () => {
    const res = await controller.getDashboard();
    expect(res).toBeDefined();
    expect(res.system).toBeDefined();
    expect(res.rooms.activeVideoRooms).toBe(5);
  });

  it('should return production readiness report', async () => {
    const res = await controller.getReadinessReport();
    expect(res).toBeDefined();
    expect(res.overallReadinessScore).toBe(100);
    expect(res.scores.securityScore).toBe(100);
    expect(res.status).toBe('PRODUCTION_READY');
  });

  it('should return launch readiness report', async () => {
    const res = await controller.getLaunchReadiness();
    expect(res).toBeDefined();
    expect(res.launchStatus).toBe('APPROVED_FOR_LAUNCH');
    expect(res.readinessScore).toBe(100);
  });

  it('should return executive dashboard overview', async () => {
    const res = await controller.getExecutiveDashboard();
    expect(res.executiveSummary).toBeDefined();
    expect(res.executiveSummary.systemHealth).toBe('OPTIMAL');
  });

  it('should return SLO dashboard report', async () => {
    const res = await controller.getSLODashboard();
    expect(res.sloTargets).toHaveLength(5);
    expect(res.overallSloCompliance).toBe('100%');
  });

  it('should return real-time launch monitoring metrics', async () => {
    const res = await controller.getLaunchMonitoring();
    expect(res.launchState).toBe('LIVE_LAUNCH_MONITORING');
    expect(res.realtimeMetrics.agoraRtcStatus).toBe('HEALTHY');
  });

  it('should return security compliance report', async () => {
    const res = await controller.getCompliance();
    expect(res.status).toBe('FULLY_COMPLIANT');
    expect(res.score).toBe(100);
  });

  it('should return global launch certification report', async () => {
    const res = await controller.getCertification();
    expect(res.certificationStatus).toBe('CERTIFIED_FOR_GLOBAL_LAUNCH');
    expect(res.overallCertificationScore).toBe(100);
    expect(res.componentCertifications.restApiValidation.status).toBe('PASSED');
  });

  it('should return exceptions analytics', async () => {
    const res = await controller.getExceptions();
    expect(res.summary).toBeDefined();
  });

  it('should return database performance report', async () => {
    const res = await controller.getDatabasePerformance();
    expect(res.statistics).toBeDefined();
  });

  it('should return security audit', async () => {
    const res = await controller.getSecurityAudit();
    expect(res.securityScore).toBe(100);
  });

  it('should run stress scenario', async () => {
    const res = await controller.runStress('500');
    expect(res.simulatedUsers).toBe(500);
  });

  it('should run chaos simulation', async () => {
    const res = await controller.runChaos('agora');
    expect(res.recovered).toBe(true);
  });
});
