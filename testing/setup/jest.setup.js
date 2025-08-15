// Jest setup file for AI Aggregator migration testing
require('dotenv').config();

// Global test configuration
global.TEST_CONFIG = {
  TIMEOUT: 30000,
  STAGING_URL: process.env.STAGING_URL || 'https://aiag-staging.vercel.app',
  PRODUCTION_URL: process.env.PRODUCTION_URL || 'https://aiag.vercel.app',
  LOCAL_URL: process.env.LOCAL_URL || 'http://localhost:5000',
  
  // Database configuration
  MONGODB_URI: process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/aiag_test',
  POSTGRES_URI: process.env.POSTGRES_TEST_URI || 'postgresql://localhost:5432/aiag_hub_test',
  
  // Test user credentials
  TEST_USER: {
    email: 'test@aiag.com',
    password: 'testpassword123',
    username: 'testuser'
  },
  
  // API endpoints
  ENDPOINTS: {
    AUTH: '/auth',
    USER: '/user',
    MARKET: '/market',
    PRODUCT: '/product',
    ORG: '/org',
    CONTEST: '/contest',
    REQUEST: '/request',
    PRICING: '/pricing',
    PAYMENT: '/payment',
    STATISTICS: '/statistics',
    FEED: '/feed',
    HUB: '/hub',
    FILES: '/api/files'
  }
};

// Global test utilities
global.TestUtils = {
  // Generate random test data
  generateTestUser: () => ({
    email: `test-${Date.now()}@aiag.com`,
    password: 'testpassword123',
    username: `testuser${Date.now()}`,
    firstName: 'Test',
    lastName: 'User'
  }),
  
  generateTestOrg: () => ({
    name: `Test Organization ${Date.now()}`,
    description: 'Test organization for testing purposes',
    website: 'https://test.com'
  }),
  
  generateTestProduct: () => ({
    name: `Test Product ${Date.now()}`,
    description: 'Test product for testing purposes',
    category: 'AI Tools',
    pricing: 'Free'
  }),
  
  // Wait utility
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // Generate JWT token for testing
  generateTestToken: (payload = {}) => {
    const jwt = require('jsonwebtoken');
    return jwt.sign(
      { 
        userId: 'test-user-id',
        email: 'test@aiag.com',
        ...payload 
      },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' }
    );
  }
};

// Increase test timeout
jest.setTimeout(global.TEST_CONFIG.TIMEOUT);

// Console override for cleaner test output
const originalConsole = console;
global.console = {
  ...originalConsole,
  log: jest.fn((...args) => {
    if (process.env.NODE_ENV !== 'test' || process.env.DEBUG_TESTS) {
      originalConsole.log(...args);
    }
  }),
  warn: originalConsole.warn,
  error: originalConsole.error
};