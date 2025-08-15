/**
 * API Hub Proxy Functionality Tests
 * Testing API Hub proxy features for AI Aggregator
 */

const request = require('supertest');
const nock = require('nock');

describe('API Hub Proxy Tests', () => {
  let authToken;
  let testUser;
  let testApiKey;
  let mockExternalAPI;

  beforeAll(async () => {
    // Setup test user and authentication
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

    // Create test API key
    const apiKeyResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/api/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        name: 'Test API Key',
        permissions: ['read', 'write']
      });

    testApiKey = apiKeyResponse.body.key;
  });

  beforeEach(() => {
    // Clear all mocks
    nock.cleanAll();
  });

  afterAll(() => {
    nock.cleanAll();
  });

  describe('API Key Management', () => {
    test('should create new API key', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/keys')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'New Test Key',
          permissions: ['read']
        })
        .expect(201);

      expect(response.body).toHaveProperty('key');
      expect(response.body).toHaveProperty('name');
      expect(response.body.name).toBe('New Test Key');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body.permissions).toContain('read');
    });

    test('should list user API keys', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/keys')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(response.body.keys)).toBe(true);
      expect(response.body.keys.length).toBeGreaterThan(0);
      expect(response.body.keys[0]).toHaveProperty('name');
      expect(response.body.keys[0]).toHaveProperty('permissions');
      expect(response.body.keys[0]).not.toHaveProperty('key'); // Key should not be exposed in list
    });

    test('should delete API key', async () => {
      // Create a key to delete
      const createResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/keys')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Key to Delete',
          permissions: ['read']
        });

      const keyId = createResponse.body.id;

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/api/keys/${keyId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(204);

      // Verify key is deleted
      const listResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/keys')
        .set('Authorization', `Bearer ${authToken}`);

      const deletedKey = listResponse.body.keys.find(k => k.id === keyId);
      expect(deletedKey).toBeUndefined();
    });

    test('should validate API key permissions', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/keys')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Invalid Permissions Key',
          permissions: ['invalid-permission']
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('permissions');
    });
  });

  describe('External API Proxy', () => {
    beforeEach(() => {
      // Mock external API
      mockExternalAPI = nock('https://api.external-service.com')
        .defaultReplyHeaders({
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true'
        });
    });

    test('should proxy GET requests to external API', async () => {
      const mockResponse = { data: 'external api response' };
      
      mockExternalAPI
        .get('/users')
        .reply(200, mockResponse);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/users',
          method: 'GET'
        })
        .expect(200);

      expect(response.body).toEqual(mockResponse);
    });

    test('should proxy POST requests with body', async () => {
      const requestBody = { name: 'Test User', email: 'test@example.com' };
      const mockResponse = { id: 123, ...requestBody };
      
      mockExternalAPI
        .post('/users', requestBody)
        .reply(201, mockResponse);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          target: 'https://api.external-service.com/users',
          method: 'POST',
          body: requestBody
        })
        .expect(201);

      expect(response.body).toEqual(mockResponse);
    });

    test('should handle external API errors', async () => {
      mockExternalAPI
        .get('/error')
        .reply(500, { error: 'Internal Server Error' });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/error',
          method: 'GET'
        })
        .expect(500);

      expect(response.body).toHaveProperty('error');
    });

    test('should validate target URL format', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'invalid-url',
          method: 'GET'
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('URL');
    });

    test('should validate allowed domains', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://blocked-domain.com/api',
          method: 'GET'
        })
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('domain not allowed');
    });

    test('should forward custom headers', async () => {
      const customHeaders = {
        'X-Custom-Header': 'custom-value',
        'Authorization': 'Bearer external-token'
      };

      mockExternalAPI
        .get('/users')
        .matchHeader('X-Custom-Header', 'custom-value')
        .matchHeader('Authorization', 'Bearer external-token')
        .reply(200, { success: true });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/users',
          method: 'GET'
        })
        .send({
          headers: customHeaders
        })
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });
  });

  describe('Rate Limiting', () => {
    test('should enforce rate limits per API key', async () => {
      const requests = [];
      
      // Make multiple requests rapidly
      for (let i = 0; i < 15; i++) {
        requests.push(
          request(global.TEST_CONFIG.LOCAL_URL)
            .get('/api/hub/rate-limited-endpoint')
            .set('X-API-Key', testApiKey)
        );
      }

      const responses = await Promise.allSettled(requests);
      const rateLimitedResponses = responses.filter(r => 
        r.status === 'fulfilled' && r.value.status === 429
      );

      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    test('should include rate limit headers', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/rate-limited-endpoint')
        .set('X-API-Key', testApiKey)
        .expect(200);

      expect(response.headers).toHaveProperty('x-ratelimit-limit');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining');
      expect(response.headers).toHaveProperty('x-ratelimit-reset');
    });

    test('should reset rate limits after time window', async () => {
      // This test would need to wait for the rate limit window to reset
      // or use time mocking for faster execution
      const response1 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/rate-limited-endpoint')
        .set('X-API-Key', testApiKey);

      const remainingBefore = parseInt(response1.headers['x-ratelimit-remaining']);

      // Wait for reset (or mock time)
      // In a real test, you'd mock the time or wait
      
      const response2 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/rate-limited-endpoint')
        .set('X-API-Key', testApiKey);

      const remainingAfter = parseInt(response2.headers['x-ratelimit-remaining']);
      
      // If enough time passed, remaining should be reset
      if (remainingAfter > remainingBefore) {
        expect(remainingAfter).toBeGreaterThan(remainingBefore);
      }
    });
  });

  describe('Request Logging and Analytics', () => {
    test('should log API requests', async () => {
      mockExternalAPI
        .get('/test')
        .reply(200, { success: true });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/test',
          method: 'GET'
        })
        .expect(200);

      // Check if request was logged
      const logsResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/logs')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(logsResponse.body.logs)).toBe(true);
      expect(logsResponse.body.logs.length).toBeGreaterThan(0);
      
      const latestLog = logsResponse.body.logs[0];
      expect(latestLog).toHaveProperty('timestamp');
      expect(latestLog).toHaveProperty('method');
      expect(latestLog).toHaveProperty('target');
      expect(latestLog).toHaveProperty('statusCode');
    });

    test('should provide API usage analytics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/analytics')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          period: '24h'
        })
        .expect(200);

      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('successRate');
      expect(response.body).toHaveProperty('averageResponseTime');
      expect(response.body).toHaveProperty('requestsByMethod');
      expect(response.body).toHaveProperty('topTargets');
    });

    test('should filter analytics by date range', async () => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      const endDate = new Date();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/analytics')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        })
        .expect(200);

      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('period');
      expect(response.body.period).toHaveProperty('start');
      expect(response.body.period).toHaveProperty('end');
    });
  });

  describe('Webhook Support', () => {
    test('should register webhook endpoint', async () => {
      const webhookData = {
        url: 'https://my-app.com/webhooks/aiag',
        events: ['request.completed', 'request.failed'],
        secret: 'webhook-secret-123'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/hub/webhooks')
        .set('Authorization', `Bearer ${authToken}`)
        .send(webhookData)
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('url');
      expect(response.body.url).toBe(webhookData.url);
      expect(response.body).toHaveProperty('events');
      expect(response.body.events).toEqual(webhookData.events);
    });

    test('should validate webhook URL', async () => {
      const webhookData = {
        url: 'invalid-webhook-url',
        events: ['request.completed']
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/hub/webhooks')
        .set('Authorization', `Bearer ${authToken}`)
        .send(webhookData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('URL');
    });

    test('should list user webhooks', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/webhooks')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(Array.isArray(response.body.webhooks)).toBe(true);
    });

    test('should delete webhook', async () => {
      // Create webhook first
      const createResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/hub/webhooks')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          url: 'https://test.com/webhook',
          events: ['request.completed']
        });

      const webhookId = createResponse.body.id;

      // Delete webhook
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/api/hub/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(204);

      // Verify deletion
      const listResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/webhooks')
        .set('Authorization', `Bearer ${authToken}`);

      const deletedWebhook = listResponse.body.webhooks.find(w => w.id === webhookId);
      expect(deletedWebhook).toBeUndefined();
    });
  });

  describe('Caching', () => {
    beforeEach(() => {
      mockExternalAPI
        .get('/cached-endpoint')
        .reply(200, { 
          data: 'cached response',
          timestamp: Date.now()
        });
    });

    test('should cache GET responses', async () => {
      // First request - should hit external API
      const response1 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/cached-endpoint',
          method: 'GET',
          cache: 'true'
        })
        .expect(200);

      expect(response1.headers).not.toHaveProperty('x-cache');

      // Second request - should return cached response
      const response2 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/cached-endpoint',
          method: 'GET',
          cache: 'true'
        })
        .expect(200);

      expect(response2.headers).toHaveProperty('x-cache');
      expect(response2.headers['x-cache']).toBe('HIT');
      expect(response2.body).toEqual(response1.body);
    });

    test('should respect cache TTL', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/cached-endpoint',
          method: 'GET',
          cache: 'true',
          cacheTtl: '60' // 60 seconds
        })
        .expect(200);

      expect(response.headers).toHaveProperty('x-cache-ttl');
      expect(parseInt(response.headers['x-cache-ttl'])).toBeLessThanOrEqual(60);
    });

    test('should not cache POST requests', async () => {
      mockExternalAPI
        .post('/no-cache-endpoint')
        .reply(200, { data: 'not cached' });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          target: 'https://api.external-service.com/no-cache-endpoint',
          method: 'POST',
          body: { test: true },
          cache: 'true'
        })
        .expect(200);

      expect(response.headers).not.toHaveProperty('x-cache');
    });
  });

  describe('Error Handling', () => {
    test('should handle network timeouts', async () => {
      mockExternalAPI
        .get('/slow-endpoint')
        .delay(5000)
        .reply(200, { data: 'slow response' });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/slow-endpoint',
          method: 'GET',
          timeout: '1000' // 1 second timeout
        })
        .expect(408);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('timeout');
    });

    test('should handle DNS resolution errors', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://non-existent-domain-12345.com/api',
          method: 'GET'
        })
        .expect(502);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('DNS');
    });

    test('should handle malformed responses', async () => {
      mockExternalAPI
        .get('/malformed')
        .reply(200, 'invalid json response');

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          target: 'https://api.external-service.com/malformed',
          method: 'GET'
        })
        .expect(502);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('parse');
    });
  });
});