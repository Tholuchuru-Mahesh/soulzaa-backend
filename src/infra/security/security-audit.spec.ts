import { Test, TestingModule } from '@nestjs/testing';
import { SecurityAuditService } from './security-audit.service';

describe('SecurityAuditService', () => {
  let service: SecurityAuditService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SecurityAuditService],
    }).compile();

    service = module.get<SecurityAuditService>(SecurityAuditService);
  });

  it('should record threat event', () => {
    service.recordThreat('XSS_ATTEMPT', '192.168.1.1', '/api/v1/chat', '<script>');
    const metrics = service.getSecurityMetrics();
    expect(metrics.totalThreatEvents).toBe(1);
    expect(metrics.threats[0].type).toBe('XSS_ATTEMPT');
  });

  it('should generate security posture audit', () => {
    const audit = service.auditSecurityPosture();
    expect(audit.securityScore).toBe(100);
    expect(audit.compliance.helmetEnabled).toBe(true);
  });
});
