import http from 'k6/http';
import { config } from '../config/environments.js';
import { testData } from '../config/test-data.js';

export function login(userIndex = 0) {
  // A pre-issued token (TEST_TOKEN) always wins — useful against remote
  // environments where load-test credentials are not provisioned.
  if (testData.auth.token) {
    return testData.auth.token;
  }

  const user = testData.users[userIndex];

  const res = http.post(
    `${config.BASE_URL}/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (res.status !== 200 && res.status !== 201) {
    console.error(`Login failed for ${user.email} (${res.status}): ${res.body}`);
    return null;
  }

  try {
    // Envelope shape: { success, data: { user, tokens: { accessToken, ... } } }
    const token = res.json().data?.tokens?.accessToken;
    if (!token) {
      console.error(`Login succeeded but no accessToken in response: ${res.body}`);
    }
    return token;
  } catch (e) {
    console.error(`Failed to parse login response: ${res.body}`);
    return null;
  }
}
