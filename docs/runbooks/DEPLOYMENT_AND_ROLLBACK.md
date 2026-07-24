# Deployment & Rollback Operational Runbook

## 🚀 Standard Deployment Procedures

### Zero-Downtime Rolling Update (Automated via CI/CD)
The GitHub Actions workflow (`.github/workflows/ci-cd.yml`) handles zero-downtime deployments automatically upon merging code into `main`.

### Manual Zero-Downtime Deployment
```bash
kubectl set image deployment/soulzaa-api api=ghcr.io/soulzaaa/soulzaa-backend:sha-<commit_hash> -n soulzaa-prod
kubectl rollout status deployment/soulzaa-api -n soulzaa-prod
```

### Progressive Canary Deployment
```bash
./deploy/canary-deploy.sh ghcr.io/soulzaaa/soulzaa-backend:sha-<commit_hash> 20
```

---

## ↩️ Immediate Rollback Procedure

If readiness probes fail or error rate spikes post-deploy:

```bash
# 1. Rollback to previous deployment revision
kubectl rollout undo deployment/soulzaa-api -n soulzaa-prod

# 2. Check rollout status
kubectl rollout status deployment/soulzaa-api -n soulzaa-prod

# 3. Verify platform readiness
curl https://api.soulzaa.com/health/ready
```
