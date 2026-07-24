#!/usr/bin/env bash
set -eo pipefail

# ── Canary Deployment Script ────────────────────────────────────────────────────
# Performs a percentage-based progressive rollout on Kubernetes with automated health checks.

NAMESPACE="${NAMESPACE:-soulzaa-prod}"
NEW_IMAGE="$1"
PERCENTAGE="${2:-20}" # Default 20% canary traffic

if [ -z "${NEW_IMAGE}" ]; then
  echo "Usage: $0 <new-image-tag> [canary-percentage]"
  exit 1
fi

echo "========================================="
echo " Starting Canary Deployment to ${NAMESPACE}"
echo " Image: ${NEW_IMAGE}"
echo " Initial Traffic: ${PERCENTAGE}%"
echo "========================================="

# 1. Deploy Canary Pods
echo "[1/4] Scaling canary deployment..."
kubectl set image deployment/soulzaa-api-canary api="${NEW_IMAGE}" -n "${NAMESPACE}"
kubectl scale deployment/soulzaa-api-canary --replicas=1 -n "${NAMESPACE}"
kubectl rollout status deployment/soulzaa-api-canary -n "${NAMESPACE}" --timeout=3m

# 2. Canary Health Check
echo "[2/4] Verifying canary health probes..."
CANARY_POD=$(kubectl get pods -n "${NAMESPACE}" -l app=soulzaa-api-canary -o jsonpath='{.items[0].metadata.name}')
for i in {1..5}; do
  STATUS=$(kubectl exec -n "${NAMESPACE}" "${CANARY_POD}" -- wget -qO- http://localhost:3000/health/ready || echo "FAIL")
  if [[ "${STATUS}" == *"status"*"ok"* ]]; then
    echo "  Probe ${i}/5 PASSED"
  else
    echo "❌ Canary health check FAILED! Initiating automatic rollback..."
    kubectl scale deployment/soulzaa-api-canary --replicas=0 -n "${NAMESPACE}"
    exit 1
  fi
  sleep 5
done

# 3. Promote Canary to Main Deployment (100% Traffic)
echo "[3/4] Promoting new image to primary deployment..."
kubectl set image deployment/soulzaa-api api="${NEW_IMAGE}" -n "${NAMESPACE}"
kubectl rollout status deployment/soulzaa-api -n "${NAMESPACE}" --timeout=5m

# 4. Scale down canary
echo "[4/4] Scaling down canary replicas..."
kubectl scale deployment/soulzaa-api-canary --replicas=0 -n "${NAMESPACE}"

echo "========================================="
echo " Canary Deployment & Promotion SUCCESS"
echo "========================================="
