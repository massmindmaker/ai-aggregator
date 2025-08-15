/**
 * Artillery Load Test Processor
 * Custom functions for load testing AI Aggregator
 */

const jwt = require('jsonwebtoken');

module.exports = {
  generateAuthToken,
  recordColdStartTime,
  measureColdStartTime,
  generateTestUser,
  createTestProduct,
  validateResponse,
  trackMetrics
};

// Cache for auth tokens to avoid excessive login requests
const tokenCache = new Map();
const coldStartTimes = new Map();

/**
 * Generate or retrieve cached auth token
 */
function generateAuthToken(requestParams, context, ee, next) {
  const userId = context.vars.userId || 'loadtest-user';
  
  // Check if we have a valid cached token
  if (tokenCache.has(userId)) {
    const cached = tokenCache.get(userId);
    if (Date.now() < cached.expiresAt) {
      context.vars.authToken = cached.token;
      return next();
    }
  }

  // Generate new token (in real scenario, this would be from login)
  const token = jwt.sign(
    { 
      userId: userId,
      email: `${userId}@aiag.com`,
      exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour
    },
    process.env.JWT_SECRET || 'test-secret'
  );

  // Cache the token
  tokenCache.set(userId, {
    token: token,
    expiresAt: Date.now() + (55 * 60 * 1000) // 55 minutes
  });

  context.vars.authToken = token;
  next();
}

/**
 * Record timestamp before cold start request
 */
function recordColdStartTime(requestParams, context, ee, next) {
  const requestId = `${requestParams.url}-${Date.now()}`;
  coldStartTimes.set(requestId, Date.now());
  context.vars.coldStartRequestId = requestId;
  next();
}

/**
 * Measure cold start time and emit custom metric
 */
function measureColdStartTime(requestParams, response, context, ee, next) {
  const requestId = context.vars.coldStartRequestId;
  if (coldStartTimes.has(requestId)) {
    const startTime = coldStartTimes.get(requestId);
    const coldStartTime = Date.now() - startTime;
    
    // Emit custom metric
    ee.emit('counter', 'cold_start.requests', 1);
    ee.emit('histogram', 'cold_start.response_time', coldStartTime);
    
    // Log cold start times over threshold
    if (coldStartTime > 1000) {
      ee.emit('counter', 'cold_start.slow_requests', 1);
      console.log(`Cold start detected: ${requestParams.url} took ${coldStartTime}ms`);
    }
    
    coldStartTimes.delete(requestId);
  }
  next();
}

/**
 * Generate test user data
 */
function generateTestUser(requestParams, context, ee, next) {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  
  context.vars.testUser = {
    email: `loadtest-${timestamp}-${random}@aiag.com`,
    password: `LoadTest${random}!`,
    username: `loadtest${random}`,
    firstName: `Load`,
    lastName: `Test${random}`
  };
  
  next();
}

/**
 * Create test product data
 */
function createTestProduct(requestParams, context, ee, next) {
  const categories = ['ai', 'ml', 'data-processing', 'search', 'nlp', 'computer-vision'];
  const pricingTypes = ['Free', 'Premium', 'Enterprise', 'Pay-per-use'];
  const random = Math.floor(Math.random() * 10000);
  
  context.vars.testProduct = {
    name: `Load Test Product ${random}`,
    description: `Product created during load testing at ${new Date().toISOString()}`,
    category: categories[Math.floor(Math.random() * categories.length)],
    pricing: pricingTypes[Math.floor(Math.random() * pricingTypes.length)],
    tags: ['load-test', 'performance', 'testing'],
    apiEndpoints: [
      {
        method: 'POST',
        path: `/api/test/${random}`,
        description: 'Test endpoint for load testing'
      }
    ]
  };
  
  next();
}

/**
 * Validate response and emit custom metrics
 */
function validateResponse(requestParams, response, context, ee, next) {
  const url = requestParams.url;
  const method = requestParams.method || 'GET';
  const statusCode = response.statusCode;
  const responseTime = response.timings?.phases?.total || 0;
  
  // Emit endpoint-specific metrics
  const endpointName = getEndpointName(url, method);
  ee.emit('histogram', `response_time.${endpointName}`, responseTime);
  ee.emit('counter', `requests.${endpointName}.${statusCode}`, 1);
  
  // Check for slow responses
  if (responseTime > 2000) {
    ee.emit('counter', 'slow_responses', 1);
    console.log(`Slow response: ${method} ${url} took ${responseTime}ms`);
  }
  
  // Check for errors
  if (statusCode >= 400) {
    ee.emit('counter', 'error_responses', 1);
    if (statusCode >= 500) {
      ee.emit('counter', 'server_errors', 1);
      console.log(`Server error: ${method} ${url} returned ${statusCode}`);
    }
  }
  
  // Validate response body for specific endpoints
  if (statusCode === 200 && response.body) {
    try {
      const body = JSON.parse(response.body);
      validateResponseBody(url, method, body, ee);
    } catch (error) {
      ee.emit('counter', 'invalid_json_responses', 1);
    }
  }
  
  next();
}

/**
 * Track custom metrics during test
 */
function trackMetrics(requestParams, context, ee, next) {
  // Track memory usage if available
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const memory = process.memoryUsage();
    ee.emit('histogram', 'memory.rss', memory.rss);
    ee.emit('histogram', 'memory.heapUsed', memory.heapUsed);
  }
  
  // Track active connections (approximate)
  const activeConnections = tokenCache.size;
  ee.emit('histogram', 'connections.active', activeConnections);
  
  next();
}

/**
 * Helper function to get endpoint name for metrics
 */
function getEndpointName(url, method) {
  // Normalize URL for metrics
  let endpoint = url
    .replace(/\/[a-f0-9]{24}/g, '/:id') // Replace MongoDB ObjectIds
    .replace(/\/\d+/g, '/:id') // Replace numeric IDs
    .replace(/\?.*$/, '') // Remove query parameters
    .replace(/^\//, '') // Remove leading slash
    .replace(/\//g, '_'); // Replace slashes with underscores
  
  return `${method.toLowerCase()}_${endpoint || 'root'}`;
}

/**
 * Validate response body structure
 */
function validateResponseBody(url, method, body, ee) {
  // Validate authentication responses
  if (url.includes('/auth/login') && method === 'POST') {
    if (!body.token || !body.user) {
      ee.emit('counter', 'invalid_auth_response', 1);
    }
  }
  
  // Validate product responses
  if (url.includes('/product') && method === 'GET') {
    if (Array.isArray(body)) {
      // Product list
      body.forEach(product => {
        if (!product._id || !product.name) {
          ee.emit('counter', 'invalid_product_structure', 1);
        }
      });
    } else if (body._id) {
      // Single product
      if (!body.name || !body.category) {
        ee.emit('counter', 'invalid_product_structure', 1);
      }
    }
  }
  
  // Validate file upload responses
  if (url.includes('/files/upload') && method === 'POST') {
    if (!body.url || !body.filename) {
      ee.emit('counter', 'invalid_upload_response', 1);
    }
  }
  
  // Validate API Hub responses
  if (url.includes('/api/hub')) {
    if (url.includes('/analytics')) {
      if (!body.totalRequests && body.totalRequests !== 0) {
        ee.emit('counter', 'invalid_analytics_response', 1);
      }
    }
  }
}

// Cleanup function called at the end of test
process.on('exit', () => {
  console.log('\nLoad test completed. Final metrics:');
  console.log(`Cached tokens: ${tokenCache.size}`);
  console.log(`Pending cold start measurements: ${coldStartTimes.size}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, cleaning up...');
  tokenCache.clear();
  coldStartTimes.clear();
  process.exit(0);
});