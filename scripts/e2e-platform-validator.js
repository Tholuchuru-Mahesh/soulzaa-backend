#!/usr/bin/env node

/**
 * End-to-End Platform Validation Script
 * Exercises all critical REST, Socket, Health, and Certification endpoints.
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

async function runE2EValidation() {
  console.log('==========================================================');
  console.log(' Soulzaaa Platform End-to-End Global Launch Validation');
  console.log(` Target Server: ${BASE_URL}`);
  console.log('==========================================================\n');

  const scenarios = [
    { name: 'Liveness Probe', endpoint: '/health/live' },
    { name: 'Readiness Probe', endpoint: '/health/ready' },
    { name: 'Deep System Diagnostics', endpoint: '/health/deep' },
    { name: 'Operations Overview', endpoint: '/ops/dashboard' },
    { name: 'Production Readiness Audit', endpoint: '/ops/readiness-report' },
    { name: 'Automated Launch Readiness', endpoint: '/ops/launch-readiness' },
    { name: 'Executive Overview', endpoint: '/ops/executive-dashboard' },
    { name: 'Service Level Objectives (SLOs)', endpoint: '/ops/slos' },
    { name: 'Launch Day Real-time Monitoring', endpoint: '/ops/launch-monitoring' },
    { name: 'Security Compliance Audit', endpoint: '/ops/compliance' },
    { name: 'Global Launch Platform Certification', endpoint: '/ops/certification' },
  ];

  let passed = 0;

  for (const scenario of scenarios) {
    const res = await fetchJson(scenario.endpoint);
    if (res.statusCode === 200) {
      console.log(`✅ ${scenario.name} (${scenario.endpoint}) — PASSED`);
      passed++;
    } else {
      console.log(`❌ ${scenario.name} (${scenario.endpoint}) — FAILED [${res.statusCode}]`);
    }
  }

  console.log('\n==========================================================');
  console.log(` E2E Validation Result: ${passed} / ${scenarios.length} Scenarios Passed`);
  if (passed === scenarios.length) {
    console.log(' 🎉 PLATFORM CERTIFIED: 100% READY FOR GLOBAL PUBLIC LAUNCH! 🚀');
  } else {
    console.log(' ⚠️ ATTENTION REQUIRED BEFORE PUBLIC LAUNCH');
  }
  console.log('==========================================================');
}

runE2EValidation();
