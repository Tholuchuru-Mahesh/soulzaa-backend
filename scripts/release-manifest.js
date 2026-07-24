#!/usr/bin/env node

/**
 * Release Manifest Generator
 * Generates semantic build metadata, changelog summary, and deployment manifest.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getGitCommitHash() {
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

function getGitBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  } catch {
    return 'main';
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

const releaseManifest = {
  name: packageJson.name,
  version: packageJson.version,
  environment: process.env.NODE_ENV || 'production',
  commitHash: getGitCommitHash(),
  branch: getGitBranch(),
  buildTimestamp: new Date().toISOString(),
  architecture: 'NestJS Modular Monolith',
  nodeVersion: process.version,
  releaseStatus: 'RELEASE_CANDIDATE_APPROVED',
  features: [
    'Phase 0–18 Complete Social Entertainment Platform',
    'Phase 19 Distributed Infrastructure & Resiliency',
    'Phase 19.1 Enterprise Hardening & Disaster Recovery',
    'Phase 19.2 Observability, Security Intelligence & Diagnostics',
    'Phase 20 Production DevOps, K8s, CI/CD, Monitoring',
    'Phase 21 Launch Readiness, Governance, Capacity Planning',
  ],
};

const outputPath = path.join(__dirname, '../dist/release-manifest.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(releaseManifest, null, 2));

console.log('✅ Release Manifest generated successfully at dist/release-manifest.json');
console.log(JSON.stringify(releaseManifest, null, 2));
