const http = require('http');

async function testPresign() {
  const data = JSON.stringify({
    category: 'kyc-documents',
    filename: 'test-aadhaar.png',
    contentType: 'image/png',
    size: 1024
  });

  // Get login token for admin
  const loginData = JSON.stringify({ email: 'admin@soulzaa.com', password: 'Admin@123456' });

  const loginReq = http.request({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(loginData)
    }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        const token = json.data?.tokens?.accessToken || json.tokens?.accessToken;
        console.log('Login successful! Access token obtained.');

        // Test presign
        const presignReq = http.request({
          hostname: '127.0.0.1',
          port: 3000,
          path: '/api/storage/presign',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Content-Length': Buffer.byteLength(data)
          }
        }, (presignRes) => {
          let presignBody = '';
          presignRes.on('data', chunk => presignBody += chunk);
          presignRes.on('end', () => {
            console.log('Presign Response:', presignBody);
          });
        });

        presignReq.write(data);
        presignReq.end();
      } catch (e) {
        console.error('Error parsing login response:', body);
      }
    });
  });

  loginReq.write(loginData);
  loginReq.end();
}

testPresign();
