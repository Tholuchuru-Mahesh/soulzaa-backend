# Soulzaa API Load Testing Project

This project contains a complete, production-grade load testing suite using [k6](https://k6.io/) for the Soulzaa backend API.

## ⚠️ IMPORTANT SAFETY WARNING ⚠️

**Load testing can bring down your production systems and increase AWS costs.**
Before running these tests against your production EC2 instances, please understand:
- High concurrency can exhaust EC2 CPU and RAM.
- It can exhaust PostgreSQL database connections.
- It can trigger API rate limits and Web Application Firewalls (WAF).
- It can cause application downtime for real users.

**Best Practice:** Always start with `smoke` tests. Then run `load` against a staging environment before running against production. Use `TEST_MODE` to avoid destructive database changes.

## Prerequisites

1. Install [k6](https://k6.io/docs/get-started/installation/):
   ```bash
   brew install k6      # macOS
   sudo apt install k6  # Linux
   ```
2. Install Node.js dependencies (for the generator script):
   ```bash
   npm install
   ```

## Generated API Tests

This project automatically extracted all 1,317 API endpoints from the NestJS backend and generated individual test scripts in the `tests/` directory.

To regenerate these tests if the backend changes:
```bash
npm run generate
```

## Running Tests

You can run the tests using the predefined npm scripts or the shell runner.

### Using NPM Scripts
```bash
# Basic check (10 users, 1 min)
npm run smoke

# Standard load test (scales up to 500 users)
npm run load

# Stress test (scales up to 1500 users to find breaking points)
npm run stress

# Spike test (sudden jump from 50 to 500 users)
npm run spike

# Soak test (long running at 100 users for 1 hour to find memory leaks)
npm run soak
```

### Environment Overrides

By default, tests run against `http://localhost:3000/api`. To run against staging or production:

```bash
# Run against Staging
APP_ENV=staging npm run smoke

# Override URL directly
BASE_URL=https://api.example.com npm run load
```

### Using the Shell Runner

A convenient runner script `run-tests.sh` is provided.

```bash
chmod +x run-tests.sh
./run-tests.sh smoke staging
./run-tests.sh load production
```

## Monitoring EC2 & PostgreSQL

When running tests, you must monitor the backend infrastructure to find bottlenecks:

1. **EC2 Monitoring (Linux):** SSH into the server and use `htop` to check CPU and RAM usage. Use `iostat` for disk I/O. Check AWS CloudWatch for network metrics.
2. **PostgreSQL:** Use `pg_stat_statements` to find slow queries. Monitor connections to ensure the connection pool isn't exhausted.
3. **Node.js/NestJS:** Monitor the event loop lag and heap memory.

**Correlation:** If k6 shows the 95th percentile response time spiking over 2000ms, check if EC2 CPU is at 100% or if PostgreSQL is waiting on locks. If k6 reports 500/502/504 errors, your backend nodes are likely crashing or the database pool is exhausted.
