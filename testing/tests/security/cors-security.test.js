/**
 * CORS Security Tests
 * Testing Cross-Origin Resource Sharing security configuration
 */

const request = require('supertest');

describe('CORS Security Tests', () => {
  let authToken;
  let testUser;

  beforeAll(async () => {
    testUser = global.TestUtils.generateTestUser();
    
    await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/register')
      .send(testUser);

    const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password
      });

    authToken = loginResponse.body.token;
  });

  describe('CORS Origin Validation', () => {
    test('should allow requests from authorized origins', async () => {
      const authorizedOrigins = [
        'https://aiag.vercel.app',
        'https://aiag-staging.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001'
      ];

      for (const origin of authorizedOrigins) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('Origin', origin)
          .expect(200);

        expect(response.headers['access-control-allow-origin']).toBe(origin);
      }
    });

    test('should reject requests from unauthorized origins', async () => {
      const unauthorizedOrigins = [
        'https://malicious-site.com',
        'http://evil.example.com',
        'https://phishing-site.net',
        'http://192.168.1.100:8080',
        'file://',
        'null'
      ];

      for (const origin of unauthorizedOrigins) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('Origin', origin);

        // Should either reject the request or not include the origin in CORS headers
        if (response.headers['access-control-allow-origin']) {
          expect(response.headers['access-control-allow-origin']).not.toBe(origin);
        }
      }
    });

    test('should handle wildcard origin safely', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', 'https://random-domain.com');

      // Should not use wildcard (*) for authenticated requests
      if (response.headers['access-control-allow-origin']) {
        expect(response.headers['access-control-allow-origin']).not.toBe('*');
      }
    });

    test('should validate origin format', async () => {
      const malformedOrigins = [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        'ftp://malicious.com',
        'not-a-url',
        '<script>alert(1)</script>'
      ];

      for (const malformedOrigin of malformedOrigins) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('Origin', malformedOrigin);

        // Should reject malformed origins
        expect(response.headers['access-control-allow-origin']).not.toBe(malformedOrigin);
      }
    });
  });

  describe('CORS Preflight Requests', () => {
    test('should handle OPTIONS preflight correctly', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/auth/login')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type,Authorization')
        .expect(200);

      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
      expect(response.headers['access-control-allow-headers']).toContain('Authorization');
    });

    test('should reject unauthorized methods in preflight', async () => {
      const unauthorizedMethods = ['TRACE', 'CONNECT', 'PATCH'];

      for (const method of unauthorizedMethods) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .options('/auth/login')
          .set('Origin', 'https://aiag.vercel.app')
          .set('Access-Control-Request-Method', method);

        if (response.headers['access-control-allow-methods']) {
          expect(response.headers['access-control-allow-methods']).not.toContain(method);
        } else {
          expect(response.status).not.toBe(200);
        }
      }
    });

    test('should reject unauthorized headers in preflight', async () => {
      const unauthorizedHeaders = [
        'X-Custom-Admin',
        'X-Debug-Mode',
        'X-Internal-Token'
      ];

      for (const header of unauthorizedHeaders) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .options('/auth/login')
          .set('Origin', 'https://aiag.vercel.app')
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', header);

        if (response.headers['access-control-allow-headers']) {
          expect(response.headers['access-control-allow-headers']).not.toContain(header);
        }
      }
    });

    test('should set appropriate preflight cache duration', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/auth/login')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Access-Control-Request-Method', 'POST')
        .expect(200);

      if (response.headers['access-control-max-age']) {
        const maxAge = parseInt(response.headers['access-control-max-age']);
        expect(maxAge).toBeGreaterThan(0);
        expect(maxAge).toBeLessThanOrEqual(86400); // Max 24 hours
      }
    });
  });

  describe('CORS Credentials Handling', () => {
    test('should handle credentials appropriately', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      // If credentials are allowed, should be explicitly set
      if (response.headers['access-control-allow-credentials']) {
        expect(response.headers['access-control-allow-credentials']).toBe('true');
        // With credentials, origin should not be wildcard
        expect(response.headers['access-control-allow-origin']).not.toBe('*');
      }
    });

    test('should not allow credentials with wildcard origin', async () => {
      // This test ensures the server doesn't make the mistake of allowing
      // both credentials and wildcard origin
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', 'https://test-domain.com');

      const allowsCredentials = response.headers['access-control-allow-credentials'] === 'true';
      const hasWildcardOrigin = response.headers['access-control-allow-origin'] === '*';

      // These two should never both be true
      expect(allowsCredentials && hasWildcardOrigin).toBe(false);
    });
  });

  describe('CORS Headers Security', () => {
    test('should expose only safe headers', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', 'https://aiag.vercel.app')
        .expect(200);

      if (response.headers['access-control-expose-headers']) {
        const exposedHeaders = response.headers['access-control-expose-headers']
          .split(',')
          .map(h => h.trim().toLowerCase());

        // Should not expose sensitive headers
        const sensitiveHeaders = [
          'x-powered-by',
          'server',
          'x-internal-token',
          'set-cookie'
        ];

        sensitiveHeaders.forEach(header => {
          expect(exposedHeaders).not.toContain(header);
        });
      }
    });

    test('should not leak server information through CORS', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/auth/login')
        .set('Origin', 'https://malicious-site.com')
        .set('Access-Control-Request-Method', 'GET');

      // Should not provide detailed server information to unauthorized origins
      expect(response.headers['server']).toBeUndefined();
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    test('should prevent CORS header injection', async () => {
      const maliciousOrigins = [
        'https://example.com\r\nAccess-Control-Allow-Origin: https://evil.com',
        'https://example.com\nSet-Cookie: evil=value',
        'https://example.com\r\nX-Custom: injected'
      ];

      for (const maliciousOrigin of maliciousOrigins) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('Origin', maliciousOrigin);

        // Should not allow header injection through Origin header
        expect(response.headers['access-control-allow-origin']).not.toContain('\n');
        expect(response.headers['access-control-allow-origin']).not.toContain('\r');
      }
    });
  });

  describe('CORS with Different Request Types', () => {
    test('should handle simple requests correctly', async () => {
      // Simple GET request
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', 'https://aiag.vercel.app')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('https://aiag.vercel.app');
    });

    test('should handle complex requests with preflight', async () => {
      // Complex POST with custom headers
      const preflightResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/product')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type,Authorization')
        .expect(200);

      expect(preflightResponse.headers['access-control-allow-methods']).toContain('POST');

      // Actual request
      const actualResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'CORS Test Product',
          description: 'Testing CORS with complex request'
        });

      expect([200, 201, 401]).toContain(actualResponse.status);
    });

    test('should handle file upload requests', async () => {
      // Preflight for file upload
      const preflightResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/api/files/upload')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Authorization,Content-Type')
        .expect(200);

      expect(preflightResponse.headers['access-control-allow-methods']).toContain('POST');

      // Actual file upload
      const uploadResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', Buffer.from('test file content'), 'test.txt');

      expect([200, 201, 401]).toContain(uploadResponse.status);
      if (uploadResponse.headers['access-control-allow-origin']) {
        expect(uploadResponse.headers['access-control-allow-origin']).toBe('https://aiag.vercel.app');
      }
    });
  });

  describe('CORS Error Handling', () => {
    test('should handle CORS errors gracefully', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/non-existent-endpoint')
        .set('Origin', 'https://aiag.vercel.app')
        .expect(404);

      // Even for 404 errors, CORS headers should be present for authorized origins
      expect(response.headers['access-control-allow-origin']).toBe('https://aiag.vercel.app');
    });

    test('should not leak error details through CORS', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .set('Origin', 'https://malicious-site.com')
        .send({
          email: 'invalid-email',
          password: 'wrong-password'
        });

      // Should not provide CORS headers to unauthorized origins even on errors
      if (response.headers['access-control-allow-origin']) {
        expect(response.headers['access-control-allow-origin']).not.toBe('https://malicious-site.com');
      }
    });

    test('should handle missing Origin header', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .expect(200);

      // Should work without Origin header (same-origin requests)
      expect(response.status).toBe(200);
    });

    test('should handle empty Origin header', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', '')
        .expect(200);

      // Should handle empty origin gracefully
      expect(response.status).toBe(200);
    });
  });

  describe('CORS Security Best Practices', () => {
    test('should not reflect arbitrary origins', async () => {
      const testOrigin = 'https://test-reflection.com';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', testOrigin);

      // Should not simply reflect the origin without validation
      if (response.headers['access-control-allow-origin']) {
        // If the origin is allowed, it should be in the whitelist
        const allowedOrigins = [
          'https://aiag.vercel.app',
          'https://aiag-staging.vercel.app',
          'http://localhost:3000',
          'http://localhost:3001'
        ];
        
        expect(allowedOrigins).toContain(response.headers['access-control-allow-origin']);
      }
    });

    test('should implement proper origin validation logic', async () => {
      // Test subdomain attacks
      const subdomainAttacks = [
        'https://evil.aiag.vercel.app.malicious.com',
        'https://aiag.vercel.app.evil.com',
        'https://aiagvercel.app', // Missing dot
        'httpsaiag.vercel.app' // Missing colon-slash-slash
      ];

      for (const maliciousOrigin of subdomainAttacks) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('Origin', maliciousOrigin);

        expect(response.headers['access-control-allow-origin']).not.toBe(maliciousOrigin);
      }
    });

    test('should handle CORS in development vs production', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Origin', 'http://localhost:3000');

      // localhost should only be allowed in development
      if (process.env.NODE_ENV === 'production') {
        expect(response.headers['access-control-allow-origin']).not.toBe('http://localhost:3000');
      } else {
        expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      }
    });

    test('should limit CORS methods appropriately', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/product')
        .set('Origin', 'https://aiag.vercel.app')
        .set('Access-Control-Request-Method', 'GET')
        .expect(200);

      if (response.headers['access-control-allow-methods']) {
        const allowedMethods = response.headers['access-control-allow-methods']
          .split(',')
          .map(m => m.trim().toUpperCase());

        // Should only allow necessary methods
        const necessaryMethods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
        const unnecessaryMethods = ['TRACE', 'CONNECT', 'PATCH'];

        necessaryMethods.forEach(method => {
          // These methods should be allowed
          expect(allowedMethods).toContain(method);
        });

        unnecessaryMethods.forEach(method => {
          // These methods should not be allowed
          expect(allowedMethods).not.toContain(method);
        });
      }
    });
  });
});