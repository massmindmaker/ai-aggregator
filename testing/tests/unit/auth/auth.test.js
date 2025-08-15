/**
 * Authentication Unit Tests
 * Testing authentication functionality for AI Aggregator
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

describe('Authentication Tests', () => {
  let app;
  let testUser;

  beforeAll(async () => {
    // Initialize test environment
    testUser = global.TestUtils.generateTestUser();
  });

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
  });

  describe('User Registration', () => {
    test('should register a new user with valid data', async () => {
      const userData = {
        email: testUser.email,
        password: testUser.password,
        username: testUser.username,
        firstName: testUser.firstName,
        lastName: testUser.lastName
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe(userData.email);
      expect(response.body.user).not.toHaveProperty('password');
    });

    test('should not register user with duplicate email', async () => {
      const userData = {
        email: 'existing@aiag.com',
        password: 'password123',
        username: 'existinguser'
      };

      // First registration should succeed
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(userData)
        .expect(201);

      // Second registration with same email should fail
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('already exists');
    });

    test('should validate email format', async () => {
      const userData = {
        email: 'invalid-email',
        password: 'password123',
        username: 'testuser'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('valid email');
    });

    test('should validate password strength', async () => {
      const userData = {
        email: 'test@aiag.com',
        password: '123', // Too short
        username: 'testuser'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('password');
    });
  });

  describe('User Login', () => {
    beforeEach(async () => {
      // Create a test user for login tests
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send({
          email: testUser.email,
          password: testUser.password,
          username: testUser.username
        });
    });

    test('should login with valid credentials', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password
        })
        .expect(200);

      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe(testUser.email);

      // Verify JWT token structure
      const decoded = jwt.decode(response.body.token);
      expect(decoded).toHaveProperty('userId');
      expect(decoded).toHaveProperty('email');
    });

    test('should not login with invalid password', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: 'wrongpassword'
        })
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid credentials');
    });

    test('should not login with non-existent email', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: 'nonexistent@aiag.com',
          password: 'password123'
        })
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid credentials');
    });

    test('should handle empty credentials', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('JWT Token Validation', () => {
    let validToken;

    beforeEach(async () => {
      // Register and login to get a valid token
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send({
          email: testUser.email,
          password: testUser.password,
          username: testUser.username
        });

      const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password
        });

      validToken = loginResponse.body.token;
    });

    test('should access protected route with valid token', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('user');
    });

    test('should reject access with invalid token', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('should reject access without token', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('should handle expired token', async () => {
      const expiredToken = jwt.sign(
        { userId: 'test-id', email: 'test@aiag.com' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '-1h' } // Expired 1 hour ago
      );

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/user/profile')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('expired');
    });
  });

  describe('Password Reset', () => {
    beforeEach(async () => {
      // Create a test user
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/register')
        .send({
          email: testUser.email,
          password: testUser.password,
          username: testUser.username
        });
    });

    test('should initiate password reset for valid email', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/forgot-password')
        .send({
          email: testUser.email
        })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('reset');
    });

    test('should handle password reset for non-existent email', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/auth/forgot-password')
        .send({
          email: 'nonexistent@aiag.com'
        })
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Account Verification', () => {
    test('should verify account with valid token', async () => {
      // This would test email verification functionality
      // Implementation depends on the actual verification system
      const verificationToken = 'mock-verification-token';

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/auth/verify/${verificationToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('message');
    });

    test('should handle invalid verification token', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/auth/verify/invalid-token')
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });
});