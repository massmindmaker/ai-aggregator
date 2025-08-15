/**
 * API Endpoints Integration Tests
 * Comprehensive testing of all API endpoints after migration to Vercel
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

describe('API Endpoints Integration Tests', () => {
  let authToken;
  let testUser;
  let testOrg;
  let testProduct;

  beforeAll(async () => {
    // Setup test user
    testUser = global.TestUtils.generateTestUser();
    
    const registerResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/register')
      .send(testUser)
      .expect(201);

    const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password
      })
      .expect(200);

    authToken = loginResponse.body.token;
    testUser.id = registerResponse.body.user.id;
  });

  describe('Authentication Endpoints', () => {
    test('POST /auth/register should create new user', async () => {
      const newUser = global.TestUtils.generateTestUser();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(newUser)
        .expect(201);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe(newUser.email);
      expect(response.body.user).not.toHaveProperty('password');
    });

    test('POST /auth/login should authenticate user', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password
        })
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
      
      const decoded = jwt.decode(response.body.token);
      expect(decoded).toHaveProperty('userId');
      expect(decoded).toHaveProperty('email');
    });

    test('POST /auth/refresh should refresh token', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/refresh')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body.token).not.toBe(authToken);
    });

    test('POST /auth/logout should invalidate token', async () => {
      const tempUser = global.TestUtils.generateTestUser();
      
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(tempUser);

      const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: tempUser.email,
          password: tempUser.password
        });

      const tempToken = loginResponse.body.token;

      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${tempToken}`)
        .expect(200);

      // Token should be invalid after logout
      await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${tempToken}`)
        .expect(401);
    });

    test('POST /auth/forgot-password should initiate password reset', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/forgot-password')
        .send({ email: testUser.email })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('reset');
    });
  });

  describe('User Management Endpoints', () => {
    test('GET /user/profile should return user profile', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe(testUser.email);
      expect(response.body.user).not.toHaveProperty('password');
    });

    test('PUT /user/profile should update user profile', async () => {
      const updateData = {
        firstName: 'Updated',
        lastName: 'Name',
        bio: 'Updated bio'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put('/user/profile')
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.user.firstName).toBe(updateData.firstName);
      expect(response.body.user.lastName).toBe(updateData.lastName);
      expect(response.body.user.bio).toBe(updateData.bio);
    });

    test('GET /user/statistics should return user stats', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/statistics')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('apiUsage');
      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('successRate');
      expect(response.body).toHaveProperty('lastActivity');
    });

    test('POST /user/avatar should upload user avatar', async () => {
      const avatarBuffer = Buffer.from('fake-avatar-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/user/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', avatarBuffer, 'avatar.jpg')
        .expect(200);

      expect(response.body).toHaveProperty('avatarUrl');
      expect(response.body.avatarUrl).toMatch(/^https?:\/\//);
    });

    test('DELETE /user/account should delete user account', async () => {
      const tempUser = global.TestUtils.generateTestUser();
      
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(tempUser);

      const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: tempUser.email,
          password: tempUser.password
        });

      const tempToken = loginResponse.body.token;

      await request(global.TEST_CONFIG.LOCAL_URL)
        .delete('/user/account')
        .set('Authorization', `Bearer ${tempToken}`)
        .send({ password: tempUser.password })
        .expect(204);

      // User should not be able to login after deletion
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: tempUser.email,
          password: tempUser.password
        })
        .expect(401);
    });
  });

  describe('Organization Endpoints', () => {
    beforeAll(async () => {
      testOrg = global.TestUtils.generateTestOrg();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/org')
        .set('Authorization', `Bearer ${authToken}`)
        .send(testOrg)
        .expect(201);

      testOrg.id = response.body.organization.id;
    });

    test('POST /org should create new organization', async () => {
      const newOrg = global.TestUtils.generateTestOrg();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/org')
        .set('Authorization', `Bearer ${authToken}`)
        .send(newOrg)
        .expect(201);

      expect(response.body).toHaveProperty('organization');
      expect(response.body.organization.name).toBe(newOrg.name);
      expect(response.body.organization.ownerId).toBe(testUser.id);
    });

    test('GET /org should list user organizations', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/org')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('organizations');
      expect(Array.isArray(response.body.organizations)).toBe(true);
      expect(response.body.organizations.length).toBeGreaterThan(0);
    });

    test('GET /org/:id should return organization details', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/org/${testOrg.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('organization');
      expect(response.body.organization.id).toBe(testOrg.id);
      expect(response.body.organization.name).toBe(testOrg.name);
    });

    test('PUT /org/:id should update organization', async () => {
      const updateData = {
        name: 'Updated Organization Name',
        description: 'Updated description'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/org/${testOrg.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.organization.name).toBe(updateData.name);
      expect(response.body.organization.description).toBe(updateData.description);
    });

    test('POST /org/:id/members should add organization member', async () => {
      const memberUser = global.TestUtils.generateTestUser();
      
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(memberUser);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post(`/org/${testOrg.id}/members`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          email: memberUser.email,
          role: 'member'
        })
        .expect(201);

      expect(response.body).toHaveProperty('member');
      expect(response.body.member.email).toBe(memberUser.email);
      expect(response.body.member.role).toBe('member');
    });

    test('GET /org/:id/members should list organization members', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/org/${testOrg.id}/members`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('members');
      expect(Array.isArray(response.body.members)).toBe(true);
      expect(response.body.members.length).toBeGreaterThan(0);
    });
  });

  describe('Product Management Endpoints', () => {
    beforeAll(async () => {
      testProduct = global.TestUtils.generateTestProduct();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          ...testProduct,
          organizationId: testOrg.id
        })
        .expect(201);

      testProduct.id = response.body.product.id;
    });

    test('POST /product should create new product', async () => {
      const newProduct = global.TestUtils.generateTestProduct();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          ...newProduct,
          organizationId: testOrg.id
        })
        .expect(201);

      expect(response.body).toHaveProperty('product');
      expect(response.body.product.name).toBe(newProduct.name);
      expect(response.body.product.organizationId).toBe(testOrg.id);
    });

    test('GET /product should list products', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .query({ limit: 10, page: 1 })
        .expect(200);

      expect(response.body).toHaveProperty('products');
      expect(Array.isArray(response.body.products)).toBe(true);
      expect(response.body).toHaveProperty('pagination');
      expect(response.body.pagination).toHaveProperty('total');
      expect(response.body.pagination).toHaveProperty('pages');
    });

    test('GET /product/:id should return product details', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${testProduct.id}`)
        .expect(200);

      expect(response.body).toHaveProperty('product');
      expect(response.body.product.id).toBe(testProduct.id);
      expect(response.body.product.name).toBe(testProduct.name);
    });

    test('PUT /product/:id should update product', async () => {
      const updateData = {
        name: 'Updated Product Name',
        description: 'Updated product description',
        pricing: 'Premium'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/product/${testProduct.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.product.name).toBe(updateData.name);
      expect(response.body.product.description).toBe(updateData.description);
      expect(response.body.product.pricing).toBe(updateData.pricing);
    });

    test('POST /product/:id/image should upload product image', async () => {
      const imageBuffer = Buffer.from('fake-product-image');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post(`/product/${testProduct.id}/image`)
        .set('Authorization', `Bearer ${authToken}`)
        .attach('image', imageBuffer, 'product.jpg')
        .expect(200);

      expect(response.body).toHaveProperty('imageUrl');
      expect(response.body.imageUrl).toMatch(/^https?:\/\//);
    });

    test('GET /product/:id/statistics should return product stats', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${testProduct.id}/statistics`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('views');
      expect(response.body).toHaveProperty('downloads');
      expect(response.body).toHaveProperty('rating');
      expect(response.body).toHaveProperty('usage');
    });
  });

  describe('Market Endpoints', () => {
    test('GET /market should return marketplace listings', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/market')
        .query({
          category: 'AI Tools',
          limit: 20,
          page: 1
        })
        .expect(200);

      expect(response.body).toHaveProperty('products');
      expect(Array.isArray(response.body.products)).toBe(true);
      expect(response.body).toHaveProperty('pagination');
      expect(response.body).toHaveProperty('filters');
    });

    test('GET /market/search should search marketplace', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/market/search')
        .query({
          q: 'AI algorithm',
          category: 'AI Tools',
          pricing: 'Free'
        })
        .expect(200);

      expect(response.body).toHaveProperty('results');
      expect(response.body).toHaveProperty('totalResults');
      expect(response.body).toHaveProperty('suggestions');
    });

    test('GET /market/categories should return product categories', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/market/categories')
        .expect(200);

      expect(response.body).toHaveProperty('categories');
      expect(Array.isArray(response.body.categories)).toBe(true);
      
      response.body.categories.forEach(category => {
        expect(category).toHaveProperty('name');
        expect(category).toHaveProperty('count');
        expect(category).toHaveProperty('description');
      });
    });

    test('GET /market/featured should return featured products', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/market/featured')
        .expect(200);

      expect(response.body).toHaveProperty('featured');
      expect(Array.isArray(response.body.featured)).toBe(true);
      expect(response.body).toHaveProperty('trending');
      expect(response.body).toHaveProperty('newReleases');
    });

    test('POST /market/purchase should handle product purchase', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/market/purchase')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          productId: testProduct.id,
          planId: 'basic-plan'
        })
        .expect(201);

      expect(response.body).toHaveProperty('purchase');
      expect(response.body).toHaveProperty('paymentUrl');
      expect(response.body.purchase.productId).toBe(testProduct.id);
    });
  });

  describe('API Hub Endpoints', () => {
    test('GET /hub should return API hub status', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/hub')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('version');
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body.status).toBe('operational');
    });

    test('POST /hub/proxy should proxy API requests', async () => {
      const proxyRequest = {
        endpoint: 'https://api.example.com/test',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .send(proxyRequest)
        .expect(200);

      expect(response.body).toHaveProperty('response');
      expect(response.body).toHaveProperty('metadata');
      expect(response.body.metadata).toHaveProperty('responseTime');
      expect(response.body.metadata).toHaveProperty('statusCode');
    });

    test('GET /hub/analytics should return API analytics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/hub/analytics')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ period: '7d' })
        .expect(200);

      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('successRate');
      expect(response.body).toHaveProperty('averageResponseTime');
      expect(response.body).toHaveProperty('topEndpoints');
      expect(response.body).toHaveProperty('requestsOverTime');
    });
  });

  describe('File Management Endpoints', () => {
    test('POST /api/files/upload should upload file', async () => {
      const fileBuffer = Buffer.from('test file content');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', fileBuffer, 'test-file.txt')
        .expect(201);

      expect(response.body).toHaveProperty('fileUrl');
      expect(response.body).toHaveProperty('fileId');
      expect(response.body).toHaveProperty('metadata');
    });

    test('GET /api/files should list user files', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/files')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ limit: 20 })
        .expect(200);

      expect(response.body).toHaveProperty('files');
      expect(Array.isArray(response.body.files)).toBe(true);
      expect(response.body).toHaveProperty('pagination');
    });

    test('DELETE /api/files/:id should delete file', async () => {
      // First upload a file to delete
      const fileBuffer = Buffer.from('file to delete');
      
      const uploadResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', fileBuffer, 'delete-me.txt');

      const fileId = uploadResponse.body.fileId;

      // Then delete it
      await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/api/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(204);
    });
  });

  describe('Statistics and Analytics Endpoints', () => {
    test('GET /statistics should return system statistics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/statistics')
        .expect(200);

      expect(response.body).toHaveProperty('totalUsers');
      expect(response.body).toHaveProperty('totalProducts');
      expect(response.body).toHaveProperty('totalOrganizations');
      expect(response.body).toHaveProperty('apiRequests');
      expect(response.body).toHaveProperty('activeUsers');
    });

    test('GET /statistics/performance should return performance metrics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/statistics/performance')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ period: '24h' })
        .expect(200);

      expect(response.body).toHaveProperty('averageResponseTime');
      expect(response.body).toHaveProperty('throughput');
      expect(response.body).toHaveProperty('errorRate');
      expect(response.body).toHaveProperty('uptime');
    });

    test('GET /statistics/usage should return usage analytics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/statistics/usage')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ period: '30d' })
        .expect(200);

      expect(response.body).toHaveProperty('apiCalls');
      expect(response.body).toHaveProperty('popularEndpoints');
      expect(response.body).toHaveProperty('userActivity');
      expect(response.body).toHaveProperty('resourceUtilization');
    });
  });

  describe('Health Check and Monitoring Endpoints', () => {
    test('GET /health should return health status', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('dependencies');
      expect(response.body.status).toBe('healthy');
    });

    test('GET /health/database should check database connectivity', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/health/database')
        .expect(200);

      expect(response.body).toHaveProperty('mongodb');
      expect(response.body).toHaveProperty('postgresql');
      expect(response.body.mongodb).toHaveProperty('status');
      expect(response.body.postgresql).toHaveProperty('status');
      expect(response.body.mongodb.status).toBe('connected');
      expect(response.body.postgresql.status).toBe('connected');
    });

    test('GET /health/external should check external services', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/health/external')
        .expect(200);

      expect(response.body).toHaveProperty('vercelBlob');
      expect(response.body).toHaveProperty('emailService');
      expect(response.body).toHaveProperty('paymentGateway');
      
      Object.values(response.body).forEach(service => {
        expect(service).toHaveProperty('status');
        expect(service).toHaveProperty('responseTime');
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle invalid JSON requests', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .set('Content-Type', 'application/json')
        .send('invalid-json')
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid JSON');
    });

    test('should handle requests with missing required fields', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: 'test@example.com'
          // Missing password
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('password');
    });

    test('should handle unauthorized requests', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('authorization');
    });

    test('should handle non-existent endpoints', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/non-existent-endpoint')
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    test('should handle rate limiting', async () => {
      // Make many rapid requests
      const requests = Array.from({ length: 100 }, () =>
        request(global.TEST_CONFIG.LOCAL_URL)
          .get('/health')
      );

      const responses = await Promise.all(requests);
      
      // Some requests should be rate limited
      const rateLimitedResponses = responses.filter(response => 
        response.status === 429
      );
      
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    test('should handle request timeouts', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/hub/proxy')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          endpoint: 'https://httpbin.org/delay/30', // 30 second delay
          method: 'GET',
          timeout: 1000 // 1 second timeout
        })
        .expect(408);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('timeout');
    });
  });
});