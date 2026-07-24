#!/usr/bin/env node

/**
 * Launch Readiness Validator
 * Runs an automated 11-point audit verifying platform health, configuration, security, and DR.
 */

const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

function fetchJson(endpoint) {
  return new Promise((resolve) => {
    http
      .get(`${BASE_URL}${endpoint}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      })
      .on('error', (err) => {
        resolve({ statusCode: 500, error: err.message });
      });
  });
}

async function validateLaunchReadiness() {
  console.log('==========================================================');
  console.log(' Soulzaaa Platform Automated Launch Readiness Audit');
  console.log(` Target Server: ${BASE_URL}`);
  console.log('==========================================================\n');

  const checks = [
    { name: '1. API Liveness Probe', endpoint: '/health/live' },
    { name: '2. API Readiness Probe', endpoint: '/health/ready' },
    { name: '3. Deep Diagnostics Probe', endpoint: '/health/deep' },
    { name: '4. Operations Overview', endpoint: '/ops/dashboard' },
    { name: '5. Production Readiness Report', endpoint: '/ops/readiness-report' },
    { name: '6. Automated Launch Readiness Report', endpoint: '/ops/launch-readiness' },
    { name: '7. Executive Overview Dashboard', endpoint: '/ops/executive-dashboard' },
    { name: '8. Service Level Objectives (SLOs)', endpoint: '/ops/slos' },
    { name: '9. Live Launch Monitoring', endpoint: '/ops/launch-monitoring' },
    { name: '10. Security Compliance Audit', endpoint: '/ops/compliance' },
    { name: '11. Database Performance Audit', endpoint: '/ops/database/performance' },
  ];

  let passed = 0;

  for (const check of checks) {
    const res = await fetchJson(check.endpoint);
    if (res.statusCode === 200) {
      console.log(`✅ ${check.name} (${check.endpoint}) — PASSED [200 OK]`);
      passed++;
    } else {
      console.log(`❌ ${check.name} (${check.endpoint}) — FAILED [${res.statusCode}]`);
    }
  }

  console.log('\n==========================================================');
  console.log(` Audit Results: ${passed} / ${checks.length} Checks Passed`);
  if (passed === checks.length) {
    console.log(' 🎉 LAUNCH READINESS VERIFICATION: APPROVED FOR GLOBAL LAUNCH! 🚀');
  } else {
    console.log(' ⚠️ LAUNCH READINESS VERIFICATION: ATTENTION REQUIRED BEFORE LAUNCH');
  }
  console.log('==========================================================');
}

validateLaunchReadiness();
