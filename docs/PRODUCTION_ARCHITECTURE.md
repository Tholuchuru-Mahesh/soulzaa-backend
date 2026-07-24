# Soulzaaa Production Architecture & Platform Operations Manual

This document is the master technical reference for the Soulzaaa production platform architecture.

---

## 🏛️ High-Level System Architecture

```
                                [ CloudFront CDN ]
                                        │
                             [ Nginx Ingress Controller ]
                                        │
                       ┌────────────────┴────────────────┐
                       ▼                                 ▼
             [ API Pod Replica 1-20 ]          [ BullMQ Worker Pods ]
                       │                                 │
         ┌─────────────┼─────────────┐                   │
         ▼             ▼             ▼                   ▼
    [ PgBouncer ]  [ Redis ]   [ S3 Media ]      [ Redis Queue ]
         │             │
         ▼             ▼
    [ PostgreSQL ] [ Redis Cluster ]
```

---

## 🔒 Security & Defense-In-Depth

1. **Network Isolation**: Kubernetes zero-trust `NetworkPolicy` restricts pod-to-pod ingress strictly between ingress controller and API, and egress strictly to PgBouncer, Redis, and external HTTPS.
2. **Payload Protection**: Global rate limiting guard (Redis sliding window), HTTP header security (Helmet CSP/HSTS), and idempotency interceptors.
3. **Data Integrity**: Double-entry ledger architecture with transactional isolation for wallet operations.
4. **Audit Logging**: Immutable audit records written to database and streamed via Promtail to Loki.

---

## 📊 Operations & Governance

- **Health Probes**: `/health` (liveness), `/health/ready` (readiness), `/health/deep` (full diagnostic).
- **Operations Dashboard**: `/ops/dashboard`, `/ops/readiness-report`, `/ops/launch-readiness`, `/ops/executive-dashboard`, `/ops/slos`, `/ops/launch-monitoring`, `/ops/compliance`.
- **Metrics**: `/metrics` (Prometheus text format).
- **Tracing**: W3C `traceparent` context propagation across all NestJS HTTP/WebSocket handlers.
