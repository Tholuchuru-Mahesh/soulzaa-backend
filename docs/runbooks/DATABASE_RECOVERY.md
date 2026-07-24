# Database & Cache Disaster Recovery Runbook

This document details recovery procedures for PostgreSQL, Redis, and S3 media storage.

---

## 🐘 PostgreSQL Recovery

### Point-In-Time Recovery (PITR)
1. Locate latest automated dump or AWS RDS snapshot:
   ```bash
   aws rds describe-db-snapshots --db-instance-identifier soulzaa-db-production
   ```
2. Execute automated restore script:
   ```bash
   ./scripts/backup-restore.sh
   ```
3. To manually restore dump file:
   ```bash
   pg_restore -h $POSTGRES_HOST -U soulzaa -d soulzaa -v /tmp/soulzaa-backups/postgres_YYYYMMDD.dump
   ```

---

## 🔴 Redis Cluster Recovery

1. Check Redis health: `redis-cli -h $REDIS_HOST ping`.
2. In case of memory exhaustion, check eviction policy:
   ```bash
   redis-cli -h $REDIS_HOST CONFIG GET maxmemory-policy
   ```
3. Force background save:
   ```bash
   redis-cli -h $REDIS_HOST BGSAVE
   ```
4. If Redis node crashes, persistent volume claim (PVC) auto-reloads appendonly.aof upon pod restart.

---

## 🪣 S3 Media Storage Recovery

1. Bucket versioning is enabled on `soulzaa-media-production`.
2. To restore accidentally deleted objects:
   ```bash
   aws s3api list-object-versions --bucket soulzaa-media-production
   ```
