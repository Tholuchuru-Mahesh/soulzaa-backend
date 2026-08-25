import { check, group } from 'k6';
import { authenticatedRequest } from '../../utils/http.js';
import { login } from '../../utils/auth.js';
import { config } from '../../config/environments.js';

export function setup() {
  const token = login();
  return { token };
}

export default function(data) {
  const token = data.token;
  const BASE_URL = config.BASE_URL;

  group('POST /moderator/device-change', function() {
    const url = `${BASE_URL}/moderator/device-change`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/device-change/my-requests', function() {
    const url = `${BASE_URL}/moderator/device-change/my-requests`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/device-change/pending', function() {
    const url = `${BASE_URL}/moderator/device-change/pending`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/device-change/all', function() {
    const url = `${BASE_URL}/moderator/device-change/all`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('PUT /moderator/device-change/:id/manager-review', function() {
    const url = `${BASE_URL}/moderator/device-change/12345/manager-review`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('PUT')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('PUT', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('PUT /moderator/device-change/:id/approve', function() {
    const url = `${BASE_URL}/moderator/device-change/12345/approve`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('PUT')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('PUT', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('PUT /moderator/device-change/:id/reject', function() {
    const url = `${BASE_URL}/moderator/device-change/12345/reject`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('PUT')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('PUT', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance/me', function() {
    const url = `${BASE_URL}/moderator/performance/me`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance/me/daily', function() {
    const url = `${BASE_URL}/moderator/performance/me/daily`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance/me/range', function() {
    const url = `${BASE_URL}/moderator/performance/me/range`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance', function() {
    const url = `${BASE_URL}/moderator/performance`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance/:moderatorId', function() {
    const url = `${BASE_URL}/moderator/performance/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance/:moderatorId/daily', function() {
    const url = `${BASE_URL}/moderator/performance/12345/daily`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/performance/:moderatorId/range', function() {
    const url = `${BASE_URL}/moderator/performance/12345/range`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /moderator/emergency-request', function() {
    const url = `${BASE_URL}/moderator/emergency-request`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /moderator/official-message', function() {
    const url = `${BASE_URL}/moderator/official-message`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /moderator/manager-instruction', function() {
    const url = `${BASE_URL}/moderator/manager-instruction`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /moderator/shifts/:moderatorId', function() {
    const url = `${BASE_URL}/moderator/shifts/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/shifts/me', function() {
    const url = `${BASE_URL}/moderator/shifts/me`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/shifts/me/active', function() {
    const url = `${BASE_URL}/moderator/shifts/me/active`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/shifts/:moderatorId', function() {
    const url = `${BASE_URL}/moderator/shifts/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('GET /moderator/shifts', function() {
    const url = `${BASE_URL}/moderator/shifts`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('GET')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('GET', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('PUT /moderator/shifts/:id', function() {
    const url = `${BASE_URL}/moderator/shifts/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('PUT')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('PUT', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('DELETE /moderator/shifts/:id', function() {
    const url = `${BASE_URL}/moderator/shifts/12345`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('DELETE')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('DELETE', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

  group('POST /moderator/shifts/:id/overrides', function() {
    const url = `${BASE_URL}/moderator/shifts/12345/overrides`;
    
    // Add realistic payload for POST/PUT/PATCH if needed
    let payload = null;
    if (['POST', 'PUT', 'PATCH'].includes('POST')) {
       payload = { test: 'loadtest_data' }; // Replace with realistic payload
    }
    
    const res = authenticatedRequest('POST', url, payload, token);
    
    check(res, {
      'is status 200/201/204': (r) => [200, 201, 204].includes(r.status),
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  });

}
