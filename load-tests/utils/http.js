import http from 'k6/http';

export function authenticatedRequest(method, url, body, token, additionalHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...additionalHeaders,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const params = {
    headers: headers,
  };

  const payload = body ? JSON.stringify(body) : null;

  switch (method.toUpperCase()) {
    case 'GET':
      return http.get(url, params);
    case 'POST':
      return http.post(url, payload, params);
    case 'PUT':
      return http.put(url, payload, params);
    case 'PATCH':
      return http.patch(url, payload, params);
    case 'DELETE':
      return http.del(url, payload, params);
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }
}
