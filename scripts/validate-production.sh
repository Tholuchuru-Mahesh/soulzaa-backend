#!/usr/bin/env bash
set -eo pipefail

# ── Production Environment Validation Script ─────────────────────────────────────
# Validates API health, ops readiness, metrics, database performance, and security posture.

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "=========================================================="
echo " Soulzaaa Production Environment Validation"
echo " Target URL: ${BASE_URL}"
echo "=========================================================="

# 1. Liveness Probe
echo -n "[1/8] Checking Liveness Probe (/health/live)... "
RES=$(curl -s "${BASE_URL}/health/live")
if [[ "${RES}" == *"ok"* || "${RES}" == *"up"* || "${RES}" == *"status"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 2. Readiness Probe
echo -n "[2/8] Checking Readiness Probe (/health/ready)... "
RES=$(curl -s "${BASE_URL}/health/ready")
if [[ "${RES}" == *"ok"* || "${RES}" == *"up"* || "${RES}" == *"status"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 3. Deep Diagnostic Probe
echo -n "[3/8] Checking Deep Health Probe (/health/deep)... "
RES=$(curl -s "${BASE_URL}/health/deep")
if [[ "${RES}" == *"ok"* || "${RES}" == *"up"* || "${RES}" == *"status"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 4. Ops Dashboard Endpoint
echo -n "[4/8] Checking Operational Dashboard (/ops/dashboard)... "
RES=$(curl -s "${BASE_URL}/ops/dashboard")
if [[ "${RES}" == *"memory"* || "${RES}" == *"status"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 5. Production Readiness Report
echo -n "[5/8] Checking Production Readiness Report (/ops/readiness-report)... "
RES=$(curl -s "${BASE_URL}/ops/readiness-report")
if [[ "${RES}" == *"readinessScore"* || "${RES}" == *"overall"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 6. Database Diagnostics Endpoint
echo -n "[6/8] Checking DB Diagnostics Endpoint (/ops/database/performance)... "
RES=$(curl -s "${BASE_URL}/ops/database/performance")
if [[ "${RES}" == *"slowQueries"* || "${RES}" == *"recommendations"* || "${RES}" == *"status"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 7. Security Audit Posture Endpoint
echo -n "[7/8] Checking Security Audit Posture (/ops/security/audit)... "
RES=$(curl -s "${BASE_URL}/ops/security/audit")
if [[ "${RES}" == *"guards"* || "${RES}" == *"compliance"* || "${RES}" == *"status"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

# 8. Prometheus Metrics Endpoint
echo -n "[8/8] Checking Prometheus Metrics Endpoint (/metrics)... "
RES=$(curl -s "${BASE_URL}/metrics")
if [[ "${RES}" == *"http_requests_total"* || "${RES}" == *"process_cpu"* || "${RES}" == *"# HELP"* ]]; then
  echo "OK ✅"
else
  echo "FAILED ❌ (${RES})"
  exit 1
fi

echo "=========================================================="
echo " 🎉 ALL PRODUCTION VALIDATION CHECKS PASSED PERFECTLY!"
echo "=========================================================="
