# Production Incident Response Runbook

This document defines standard operating procedures for resolving high-severity production incidents on the Soulzaaa backend.

---

## 🚨 Incident Severity Levels

| Level | Impact | Response Time | Contacts |
| :--- | :--- | :--- | :--- |
| **SEV-1** | Total platform outage or data corruption | < 15 mins | On-Call Lead + CTO |
| **SEV-2** | Critical sub-system down (e.g. Wallet, Gifts, PK Battles) | < 30 mins | On-Call Tech Lead |
| **SEV-3** | Degraded performance or non-blocking bug | < 2 hours | Primary Engineer |

---

## 🛠️ Step-by-Step Incident Workflow

### 1. Triage & Acknowledge
1. Acknowledge alert in PagerDuty / Slack `#incidents`.
2. Open incident channel `#inc-YYYYMMDD-<name>`.
3. Check overall platform status: `curl https://api.soulzaa.com/ops/readiness-report`.

### 2. Immediate Mitigation
- **High CPU / OOM / Load Spikes:**
  ```bash
  kubectl scale deployment/soulzaa-api --replicas=10 -n soulzaa-prod
  ```
- **Failing Deployment:**
  ```bash
  kubectl rollout undo deployment/soulzaa-api -n soulzaa-prod
  ```
- **Database Connection Exhaustion:**
  Verify PgBouncer pool limits via `/ops/database/performance`.

### 3. Log & Trace Investigation
- **Query Grafana Loki:** Filter by `service="soulzaa-api"` and `level="error"`.
- **Query OpenTelemetry Spans:** Inspect failing request traces via `/ops/exceptions`.

### 4. Post-Incident
- Conduct post-mortem meeting within 48 hours.
- Document root cause analysis (RCA).
