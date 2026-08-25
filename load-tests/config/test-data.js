// Generic test data, can be extended for specific scenarios.
// These accounts must exist in the target environment. Locally, create them with:
//   curl -X POST http://localhost:3000/api/auth/register -H 'Content-Type: application/json' \
//     -d '{"email":"loadtest_001@example.com","password":"L0adTest@2026","fullName":"Load Test One"}'
export const testData = {
  users: [
    { email: 'loadtest_001@example.com', password: 'L0adTest@2026' },
    { email: 'loadtest_002@example.com', password: 'L0adTest@2026' },
  ],
  auth: {
    // Pre-issued token; overrides the login flow entirely when set.
    token: __ENV.TEST_TOKEN || null,
  },
};
