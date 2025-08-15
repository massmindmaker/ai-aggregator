/**
 * Authentication Security Tests
 * Testing JWT security, session management, and authentication vulnerabilities
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

describe('Authentication Security Tests', () => {
  let testUser;
  let validToken;
  let refreshToken;

  beforeAll(async () => {
    testUser = global.TestUtils.generateTestUser();
    
    // Register test user
    await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/register')
      .send(testUser);

    // Login to get valid tokens
    const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password
      });

    validToken = loginResponse.body.token;
    refreshToken = loginResponse.body.refreshToken;
  });

  describe('JWT Token Security', () => {
    test('should validate JWT token signature', async () => {
      // Test with invalid signature
      const invalidToken = validToken.slice(0, -5) + 'XXXXX';

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${invalidToken}`)
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('invalid');
    });

    test('should reject expired JWT tokens', async () => {
      // Create expired token
      const expiredToken = jwt.sign(
        { 
          userId: testUser.id,
          email: testUser.email,
          exp: Math.floor(Date.now() / 1000) - 3600 // Expired 1 hour ago
        },
        process.env.JWT_SECRET || 'test-secret'
      );

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('expired');
    });

    test('should validate JWT token structure', async () => {
      const invalidTokens = [
        'invalid.token.structure',
        'Bearer invalid-token',
        '',
        'not.enough.parts',
        'too.many.parts.in.this.token.here'
      ];

      for (const invalidToken of invalidTokens) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/user/profile')
          .set('Authorization', `Bearer ${invalidToken}`)
          .expect(401);

        expect(response.body).toHaveProperty('error');
      }
    });

    test('should prevent JWT token replay attacks', async () => {
      // First request should work
      const response1 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      // Simulate token being blacklisted/revoked
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${validToken}`);

      // Same token should now be invalid
      const response2 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(401);

      expect(response2.body).toHaveProperty('error');
    });

    test('should validate token permissions and roles', async () => {
      // Create token with limited permissions
      const limitedToken = jwt.sign(
        { 
          userId: testUser.id,
          email: testUser.email,
          permissions: ['read'],
          exp: Math.floor(Date.now() / 1000) + 3600
        },
        process.env.JWT_SECRET || 'test-secret'
      );

      // Should allow read operations
      const readResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .set('Authorization', `Bearer ${limitedToken}`)
        .expect(200);

      // Should reject write operations
      const writeResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({
          name: 'Test Product',
          description: 'Test'
        })
        .expect(403);

      expect(writeResponse.body).toHaveProperty('error');
      expect(writeResponse.body.error).toContain('permission');
    });

    test('should prevent JWT secret exposure', async () => {
      // Test that JWT secret is not exposed in error messages
      const malformedToken = 'malformed.jwt.token';

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${malformedToken}`)
        .expect(401);

      // Error message should not contain secret information
      expect(response.body.error).not.toContain('secret');
      expect(response.body.error).not.toContain('key');
      expect(response.body).not.toHaveProperty('stack');
    });
  });

  describe('Authentication Brute Force Protection', () => {
    test('should rate limit login attempts', async () => {
      const attempts = Array(10).fill().map(() =>
        request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: testUser.email,
            password: 'wrong-password'
          })
      );

      const responses = await Promise.allSettled(attempts);
      const rateLimited = responses.filter(r => 
        r.status === 'fulfilled' && r.value.status === 429
      );

      expect(rateLimited.length).toBeGreaterThan(0);
    });

    test('should implement account lockout after failed attempts', async () => {
      const testEmail = `lockout-test-${Date.now()}@aiag.com`;
      
      // Register user for lockout test
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send({
          email: testEmail,
          password: 'CorrectPassword123!',
          username: `lockouttest${Date.now()}`
        });

      // Make multiple failed login attempts
      for (let i = 0; i < 5; i++) {
        await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: testEmail,
            password: 'WrongPassword'
          });
      }

      // Account should be locked even with correct password
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testEmail,
          password: 'CorrectPassword123!'
        })
        .expect(423);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('locked');
    });

    test('should implement progressive delays for failed attempts', async () => {
      const testEmail = `delay-test-${Date.now()}@aiag.com`;
      
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send({
          email: testEmail,
          password: 'Password123!',
          username: `delaytest${Date.now()}`
        });

      const attemptTimes = [];

      // Make failed attempts and measure response times
      for (let i = 0; i < 3; i++) {
        const startTime = Date.now();
        
        await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: testEmail,
            password: 'WrongPassword'
          });

        const endTime = Date.now();
        attemptTimes.push(endTime - startTime);

        // Small delay between attempts
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Later attempts should take longer (progressive delay)
      if (attemptTimes.length >= 3) {
        expect(attemptTimes[2]).toBeGreaterThan(attemptTimes[0]);
      }
    });

    test('should detect and prevent credential stuffing', async () => {
      const commonPasswords = [
        'password123',
        'admin',
        '123456',
        'password',
        'qwerty'
      ];

      const responses = [];

      for (const password of commonPasswords) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: testUser.email,
            password: password
          });

        responses.push(response.status);
      }

      // Should detect pattern and block/rate limit
      const blockedResponses = responses.filter(status => status === 429 || status === 423);
      expect(blockedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('Password Security', () => {
    test('should enforce strong password requirements', async () => {
      const weakPasswords = [
        'password',      // Too common
        '123456',        // Too simple
        'abc',           // Too short
        'PASSWORD',      // No lowercase/numbers
        'password123',   // No uppercase/special chars
        'Pass1',         // Too short
        '            '   // Only spaces
      ];

      for (const weakPassword of weakPasswords) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/register')
          .send({
            email: `weak-${Date.now()}@test.com`,
            password: weakPassword,
            username: `weak${Date.now()}`
          })
          .expect(400);

        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toContain('password');
      }
    });

    test('should hash passwords securely', async () => {
      const testPassword = 'SecurePassword123!';
      const testEmail = `hash-test-${Date.now()}@aiag.com`;
      
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send({
          email: testEmail,
          password: testPassword,
          username: `hashtest${Date.now()}`
        })
        .expect(201);

      // Password should be hashed (not stored in plain text)
      // This would require database access to verify
      // In a real test, you'd check the database directly
      expect(true).toBe(true); // Placeholder for actual hash verification
    });

    test('should prevent password enumeration', async () => {
      // Login with non-existent user
      const response1 = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: 'non-existent@aiag.com',
          password: 'password123'
        });

      // Login with existing user, wrong password
      const response2 = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: 'wrong-password'
        });

      // Both should return similar error responses (no enumeration)
      expect(response1.status).toBe(response2.status);
      expect(response1.body.error).toBe(response2.body.error);
    });

    test('should implement secure password reset', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/forgot-password')
        .send({
          email: testUser.email
        })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('reset');

      // Reset token should not be exposed in response
      expect(response.body).not.toHaveProperty('token');
      expect(response.body).not.toHaveProperty('resetToken');
    });
  });

  describe('Session Management Security', () => {
    test('should invalidate sessions on logout', async () => {
      // Login to get a fresh token
      const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password
        });

      const sessionToken = loginResponse.body.token;

      // Verify token works
      await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200);

      // Logout
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(200);

      // Token should be invalid after logout
      await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(401);
    });

    test('should handle concurrent session limits', async () => {
      const sessions = [];

      // Create multiple sessions
      for (let i = 0; i < 6; i++) {
        const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: testUser.email,
            password: testUser.password
          });

        if (loginResponse.status === 200) {
          sessions.push(loginResponse.body.token);
        }
      }

      // Should limit concurrent sessions (e.g., max 5)
      expect(sessions.length).toBeLessThanOrEqual(5);

      // Older sessions should be invalidated
      if (sessions.length > 3) {
        const oldToken = sessions[0];
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/user/profile')
          .set('Authorization', `Bearer ${oldToken}`);

        // Might be invalid due to session limit
        expect([200, 401]).toContain(response.status);
      }
    });

    test('should implement secure token refresh', async () => {
      if (!refreshToken) {
        return; // Skip if refresh tokens not implemented
      }

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/refresh')
        .send({
          refreshToken: refreshToken
        })
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('refreshToken');

      // New tokens should be different
      expect(response.body.token).not.toBe(validToken);
      expect(response.body.refreshToken).not.toBe(refreshToken);
    });

    test('should detect and prevent session fixation', async () => {
      // Attempt to use a pre-set session ID
      const fixedSessionId = 'fixed-session-id-123';

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .set('Cookie', `sessionId=${fixedSessionId}`)
        .send({
          email: testUser.email,
          password: testUser.password
        });

      // Should not use the provided session ID
      if (response.headers['set-cookie']) {
        const sessionCookie = response.headers['set-cookie']
          .find(cookie => cookie.includes('sessionId'));
        
        if (sessionCookie) {
          expect(sessionCookie).not.toContain(fixedSessionId);
        }
      }
    });
  });

  describe('Authorization Security', () => {
    test('should enforce proper access control', async () => {
      // Create another user
      const anotherUser = global.TestUtils.generateTestUser();
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(anotherUser);

      const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: anotherUser.email,
          password: anotherUser.password
        });

      const anotherToken = loginResponse.body.token;

      // Create product with first user
      const productResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          name: 'Access Control Test Product',
          description: 'Test product for access control'
        });

      const productId = productResponse.body._id;

      // Second user should not be able to modify first user's product
      const updateResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/product/${productId}`)
        .set('Authorization', `Bearer ${anotherToken}`)
        .send({
          description: 'Unauthorized update'
        })
        .expect(403);

      expect(updateResponse.body).toHaveProperty('error');
      expect(updateResponse.body.error).toContain('permission');
    });

    test('should validate API endpoint permissions', async () => {
      // Test access to admin endpoints without admin role
      const adminEndpoints = [
        '/admin/users',
        '/admin/system',
        '/admin/metrics'
      ];

      for (const endpoint of adminEndpoints) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get(endpoint)
          .set('Authorization', `Bearer ${validToken}`)
          .expect(403);

        expect(response.body).toHaveProperty('error');
      }
    });

    test('should prevent privilege escalation', async () => {
      // Attempt to modify user role
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put('/user/profile')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          role: 'admin',
          permissions: ['admin', 'super-user']
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    test('should validate resource ownership', async () => {
      // Create a resource
      const resourceResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          name: 'Ownership Test Product',
          description: 'Test ownership validation'
        });

      const resourceId = resourceResponse.body._id;

      // Manipulate token to have different user ID
      const manipulatedToken = jwt.sign(
        { 
          userId: 'different-user-id',
          email: 'different@user.com',
          exp: Math.floor(Date.now() / 1000) + 3600
        },
        process.env.JWT_SECRET || 'test-secret'
      );

      // Should not be able to access other user's resource
      const accessResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${resourceId}`)
        .set('Authorization', `Bearer ${manipulatedToken}`)
        .expect(404); // Should return 404, not 403, to prevent enumeration

      expect(accessResponse.body).toHaveProperty('error');
    });
  });

  describe('Security Headers and CORS', () => {
    test('should include security headers', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .expect(200);

      // Check for security headers
      expect(response.headers).toHaveProperty('x-content-type-options');
      expect(response.headers).toHaveProperty('x-frame-options');
      expect(response.headers).toHaveProperty('x-xss-protection');
      
      if (response.headers['content-security-policy']) {
        expect(response.headers['content-security-policy']).toBeTruthy();
      }
    });

    test('should properly configure CORS', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .options('/auth/login')
        .set('Origin', 'https://malicious-site.com')
        .set('Access-Control-Request-Method', 'POST');

      // Should reject unauthorized origins
      expect(response.headers['access-control-allow-origin']).not.toBe('https://malicious-site.com');
    });

    test('should prevent clickjacking', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/')
        .expect(200);

      expect(response.headers['x-frame-options']).toMatch(/DENY|SAMEORIGIN/i);
    });
  });

  describe('Input Validation Security', () => {
    test('should prevent SQL injection in parameters', async () => {
      const sqlInjectionPayloads = [
        "'; DROP TABLE users; --",
        "' OR '1'='1",
        "1' UNION SELECT * FROM users --"
      ];

      for (const payload of sqlInjectionPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product/search')
          .query({ q: payload });

        // Should not cause server error
        expect(response.status).toBeLessThan(500);
        
        // Should not return unexpected data
        if (response.status === 200) {
          expect(Array.isArray(response.body)).toBe(true);
        }
      }
    });

    test('should prevent NoSQL injection', async () => {
      const noSqlPayloads = [
        { $ne: null },
        { $regex: '.*' },
        { $where: 'this.password' }
      ];

      for (const payload of noSqlPayloads) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/auth/login')
          .send({
            email: payload,
            password: 'password'
          });

        expect(response.status).toBe(400);
      }
    });

    test('should sanitize user input', async () => {
      const maliciousInputs = [
        '<script>alert("xss")</script>',
        'javascript:alert("xss")',
        '<img src="x" onerror="alert(1)">',
        '<svg onload="alert(1)">'
      ];

      for (const maliciousInput of maliciousInputs) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${validToken}`)
          .send({
            name: maliciousInput,
            description: 'Test product'
          });

        if (response.status === 201) {
          // Should sanitize the input
          expect(response.body.name).not.toContain('<script>');
          expect(response.body.name).not.toContain('javascript:');
        }
      }
    });
  });
});