# On-Call Shift Checklist

## 📋 Shift Handover Checklist

### 1. Pre-Shift Verification (First 15 minutes)
- [ ] Check active PagerDuty alerts.
- [ ] Verify readiness score: `curl https://api.soulzaa.com/ops/readiness-report`.
- [ ] Review Grafana dashboard CPU, Memory, and Error rate graphs.
- [ ] Check BullMQ DLQ failed jobs: `curl https://api.soulzaa.com/ops/dlq`.

### 2. Daily Health Audit
- [ ] Audit DB slow queries: `curl https://api.soulzaa.com/ops/database/performance`.
- [ ] Audit Security Threat log: `curl https://api.soulzaa.com/ops/security/audit`.
- [ ] Ensure DB backups ran successfully.

### 3. End-Of-Shift Handover
- [ ] Note any ongoing incidents or open GitHub issues.
- [ ] Notify incoming engineer in `#oncall-handover`.
