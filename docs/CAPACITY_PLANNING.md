# Capacity Planning & Infrastructure Projections

This document outlines hardware, database, cache, bandwidth, and node sizing requirements for the Soulzaaa backend scaling from 100K to 10M registered users.

---

## 📊 Scale Projections

| Metric | 100K Users | 500K Users | 1 Million Users | 5 Million Users | 10 Million Users |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Peak Concurrent Users (DAU)** | 10,000 | 50,000 | 100,000 | 500,000 | 1,000,000 |
| **Peak API Request Rate (RPS)** | 1,000 req/s | 5,000 req/s | 10,000 req/s | 50,000 req/s | 100,000 req/s |
| **Active Socket Connections** | 8,000 | 40,000 | 80,000 | 400,000 | 800,000 |
| **Live Audio/Video Rooms** | 100 | 500 | 1,000 | 5,000 | 10,000 |
| **API Replica Pods (EKS)** | 3 pods | 8 pods | 15 pods | 60 pods | 120 pods |
| **PostgreSQL RDS Size** | db.t4g.medium (2 vCPU, 4GB) | db.r6g.large (2 vCPU, 16GB) | db.r6g.xlarge (4 vCPU, 32GB) | db.r6g.4xlarge (16 vCPU, 128GB) | Aurora Postgres Cluster (64 vCPU, 512GB) |
| **Redis Memory Required** | 2 GB | 8 GB | 16 GB | 64 GB | 128 GB (Redis Cluster) |
| **PgBouncer Pool Size** | 25 | 50 | 100 | 300 | 600 |
| **Monthly Storage Growth** | 50 GB | 250 GB | 500 GB | 2.5 TB | 5 TB |

---

## 🏗️ Scaling Strategies per Bottleneck

### 1. WebSockets & Real-Time Presence
- Socket.IO scaling across multi-pod pods uses **Redis Pub/Sub Adapter**.
- Maximum connection limit per Node.js process is ~15,000 concurrent sockets.
- Horizontally auto-scaled by HPA based on custom metric `socket_connections_count`.

### 2. Database Connection Pooling & I/O
- Transaction-mode PgBouncer multiplexes 10,000 client HTTP requests down to 50 active DB connections.
- Read-heavy queries (rankings, user profiles, feed) use PostgreSQL Read Replicas.

### 3. Background Queue Scaling
- BullMQ workers operate in dedicated Kubernetes worker pods, auto-scaled based on Redis queue depth (`bullmq_waiting_jobs_total > 500`).
