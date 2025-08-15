/**
 * Database Performance Tests
 * Testing MongoDB Atlas and PostgreSQL performance under load
 */

const request = require('supertest');
const { MongoClient } = require('mongodb');
const { Pool } = require('pg');
const { performance } = require('perf_hooks');

describe('Database Performance Tests', () => {
  let mongoClient;
  let pgPool;
  let authToken;
  let testUser;

  beforeAll(async () => {
    // Setup MongoDB connection with performance monitoring
    mongoClient = new MongoClient(process.env.MONGODB_URI || global.TEST_CONFIG.MONGODB_URI, {
      maxPoolSize: 50,
      minPoolSize: 5,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    await mongoClient.connect();

    // Setup PostgreSQL connection pool
    pgPool = new Pool({
      connectionString: process.env.POSTGRES_URI || global.TEST_CONFIG.POSTGRES_URI,
      max: 20,
      min: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Setup test user
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

    // Create test data for performance testing
    await setupTestData();
  });

  afterAll(async () => {
    await cleanupTestData();
    if (mongoClient) await mongoClient.close();
    if (pgPool) await pgPool.end();
  });

  async function setupTestData() {
    const db = mongoClient.db();
    const products = db.collection('products');
    const users = db.collection('users');
    const pgClient = await pgPool.connect();

    try {
      // Create test products (1000 products for performance testing)
      const testProducts = Array(1000).fill().map((_, i) => ({
        name: `Performance Test Product ${i}`,
        description: `Description for product ${i}`,
        category: ['ai', 'ml', 'data-processing', 'search', 'nlp'][i % 5],
        pricing: ['Free', 'Premium', 'Enterprise'][i % 3],
        userId: testUser.id,
        tags: [`tag${i % 10}`, `category${i % 5}`, 'performance-test'],
        apiCalls: Math.floor(Math.random() * 10000),
        views: Math.floor(Math.random() * 50000),
        likes: Math.floor(Math.random() * 1000),
        createdAt: new Date(Date.now() - (i * 1000 * 60)), // Spread over time
        updatedAt: new Date(Date.now() - (i * 500 * 60)),
        isActive: i % 10 !== 0 // 90% active
      }));

      await products.insertMany(testProducts);

      // Create test users
      const testUsers = Array(100).fill().map((_, i) => ({
        email: `perftest${i}@aiag.com`,
        username: `perftest${i}`,
        productCount: Math.floor(Math.random() * 20),
        totalViews: Math.floor(Math.random() * 100000),
        createdAt: new Date(Date.now() - (i * 24 * 60 * 60 * 1000))
      }));

      await users.insertMany(testUsers);

      // Create PostgreSQL test data
      await pgClient.query(`
        CREATE TABLE IF NOT EXISTS performance_metrics (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(255),
          metric_name VARCHAR(255),
          metric_value DECIMAL,
          endpoint VARCHAR(255),
          response_time INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test metrics (10000 records)
      const metricsData = Array(10000).fill().map((_, i) => [
        `user${i % 100}`,
        ['api_calls', 'response_time', 'errors', 'uploads'][i % 4],
        Math.random() * 1000,
        ['/product', '/auth/login', '/files/upload', '/api/hub/proxy'][i % 4],
        Math.floor(Math.random() * 2000),
        new Date(Date.now() - (i * 60 * 1000))
      ]);

      for (let i = 0; i < metricsData.length; i += 100) {
        const batch = metricsData.slice(i, i + 100);
        const values = batch.map((_, idx) => 
          `($${idx * 6 + 1}, $${idx * 6 + 2}, $${idx * 6 + 3}, $${idx * 6 + 4}, $${idx * 6 + 5}, $${idx * 6 + 6})`
        ).join(', ');
        
        await pgClient.query(
          `INSERT INTO performance_metrics (user_id, metric_name, metric_value, endpoint, response_time, created_at) VALUES ${values}`,
          batch.flat()
        );
      }

    } finally {
      pgClient.release();
    }
  }

  async function cleanupTestData() {
    const db = mongoClient.db();
    await db.collection('products').deleteMany({ userId: testUser.id });
    await db.collection('users').deleteMany({ email: /^perftest\d+@aiag\.com$/ });
    
    const pgClient = await pgPool.connect();
    try {
      await pgClient.query('DROP TABLE IF EXISTS performance_metrics');
    } finally {
      pgClient.release();
    }
  }

  describe('MongoDB Performance', () => {
    test('should handle large result set queries efficiently', async () => {
      const db = mongoClient.db();
      const products = db.collection('products');

      const startTime = performance.now();
      
      const results = await products.find({
        category: 'ai',
        isActive: true
      }).limit(100).toArray();

      const endTime = performance.now();
      const queryTime = endTime - startTime;

      expect(results.length).toBeGreaterThan(0);
      expect(queryTime).toBeLessThan(100); // Should complete within 100ms
    });

    test('should perform aggregation queries efficiently', async () => {
      const db = mongoClient.db();
      const products = db.collection('products');

      const startTime = performance.now();

      const aggregationResult = await products.aggregate([
        { $match: { isActive: true } },
        { $group: {
          _id: '$category',
          count: { $sum: 1 },
          avgViews: { $avg: '$views' },
          totalApiCalls: { $sum: '$apiCalls' }
        }},
        { $sort: { count: -1 } }
      ]).toArray();

      const endTime = performance.now();
      const queryTime = endTime - startTime;

      expect(aggregationResult.length).toBeGreaterThan(0);
      expect(queryTime).toBeLessThan(200); // Should complete within 200ms
    });

    test('should handle concurrent reads efficiently', async () => {
      const db = mongoClient.db();
      const products = db.collection('products');

      const concurrentQueries = 20;
      const queries = Array(concurrentQueries).fill().map((_, i) =>
        products.find({
          category: ['ai', 'ml', 'data-processing'][i % 3]
        }).limit(10).toArray()
      );

      const startTime = performance.now();
      const results = await Promise.all(queries);
      const endTime = performance.now();
      
      const totalTime = endTime - startTime;

      expect(results).toHaveLength(concurrentQueries);
      expect(totalTime).toBeLessThan(500); // All concurrent queries within 500ms
    });

    test('should handle text search efficiently', async () => {
      const db = mongoClient.db();
      const products = db.collection('products');

      // Ensure text index exists
      try {
        await products.createIndex({
          name: 'text',
          description: 'text',
          tags: 'text'
        });
      } catch (error) {
        // Index might already exist
      }

      const startTime = performance.now();

      const searchResults = await products.find({
        $text: { $search: 'performance test' }
      }).limit(50).toArray();

      const endTime = performance.now();
      const searchTime = endTime - startTime;

      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchTime).toBeLessThan(150); // Text search within 150ms
    });

    test('should handle bulk operations efficiently', async () => {
      const db = mongoClient.db();
      const products = db.collection('products');

      const bulkOps = Array(100).fill().map((_, i) => ({
        updateOne: {
          filter: { name: `Performance Test Product ${i}` },
          update: { $inc: { views: 1 }, $set: { lastViewed: new Date() } }
        }
      }));

      const startTime = performance.now();
      const bulkResult = await products.bulkWrite(bulkOps);
      const endTime = performance.now();

      const bulkTime = endTime - startTime;

      expect(bulkResult.modifiedCount).toBeGreaterThan(0);
      expect(bulkTime).toBeLessThan(200); // Bulk operations within 200ms
    });

    test('should maintain connection pool efficiently', async () => {
      const db = mongoClient.db();
      const admin = db.admin();

      // Get current connection stats
      const serverStatus = await admin.serverStatus();
      const initialConnections = serverStatus.connections.current;

      // Perform multiple operations
      const operations = Array(50).fill().map(() =>
        db.collection('products').findOne()
      );

      await Promise.all(operations);

      // Check connections haven't grown excessively
      const finalServerStatus = await admin.serverStatus();
      const finalConnections = finalServerStatus.connections.current;

      expect(finalConnections - initialConnections).toBeLessThan(10);
    });
  });

  describe('PostgreSQL Performance', () => {
    test('should handle complex analytical queries efficiently', async () => {
      const client = await pgPool.connect();

      try {
        const startTime = performance.now();

        const result = await client.query(`
          SELECT 
            endpoint,
            COUNT(*) as request_count,
            AVG(response_time) as avg_response_time,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time) as p95_response_time,
            PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time) as p99_response_time
          FROM performance_metrics 
          WHERE created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY endpoint
          ORDER BY request_count DESC
        `);

        const endTime = performance.now();
        const queryTime = endTime - startTime;

        expect(result.rows.length).toBeGreaterThan(0);
        expect(queryTime).toBeLessThan(100); // Complex query within 100ms
      } finally {
        client.release();
      }
    });

    test('should handle concurrent writes efficiently', async () => {
      const concurrentWrites = 20;
      const writePromises = Array(concurrentWrites).fill().map(async (_, i) => {
        const client = await pgPool.connect();
        try {
          return await client.query(
            'INSERT INTO performance_metrics (user_id, metric_name, metric_value, endpoint, response_time) VALUES ($1, $2, $3, $4, $5)',
            [`concurrent_user_${i}`, 'test_metric', Math.random() * 100, '/test', Math.floor(Math.random() * 1000)]
          );
        } finally {
          client.release();
        }
      });

      const startTime = performance.now();
      const results = await Promise.all(writePromises);
      const endTime = performance.now();

      const totalTime = endTime - startTime;

      expect(results).toHaveLength(concurrentWrites);
      expect(totalTime).toBeLessThan(300); // All writes within 300ms
    });

    test('should handle large result sets with pagination efficiently', async () => {
      const client = await pgPool.connect();

      try {
        const pageSize = 100;
        const offset = 0;

        const startTime = performance.now();

        const result = await client.query(`
          SELECT * FROM performance_metrics 
          ORDER BY created_at DESC 
          LIMIT $1 OFFSET $2
        `, [pageSize, offset]);

        const endTime = performance.now();
        const queryTime = endTime - startTime;

        expect(result.rows).toHaveLength(pageSize);
        expect(queryTime).toBeLessThan(50); // Paginated query within 50ms
      } finally {
        client.release();
      }
    });

    test('should handle connection pooling efficiently', async () => {
      const initialTotal = pgPool.totalCount;
      const initialIdle = pgPool.idleCount;

      // Perform multiple concurrent operations
      const operations = Array(30).fill().map(async () => {
        const client = await pgPool.connect();
        try {
          await client.query('SELECT NOW()');
          // Simulate some processing time
          await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
          client.release();
        }
      });

      await Promise.all(operations);

      // Pool should manage connections efficiently
      expect(pgPool.totalCount).toBeLessThanOrEqual(20); // Within max pool size
      expect(pgPool.idleCount).toBeGreaterThanOrEqual(5); // Should have idle connections
    });

    test('should handle time-series queries efficiently', async () => {
      const client = await pgPool.connect();

      try {
        const startTime = performance.now();

        const result = await client.query(`
          SELECT 
            DATE_TRUNC('hour', created_at) as hour,
            COUNT(*) as requests_per_hour,
            AVG(response_time) as avg_response_time
          FROM performance_metrics 
          WHERE created_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE_TRUNC('hour', created_at)
          ORDER BY hour DESC
          LIMIT 168
        `);

        const endTime = performance.now();
        const queryTime = endTime - startTime;

        expect(result.rows.length).toBeGreaterThan(0);
        expect(queryTime).toBeLessThan(150); // Time-series query within 150ms
      } finally {
        client.release();
      }
    });
  });

  describe('API Endpoint Performance', () => {
    test('should handle product listing with pagination efficiently', async () => {
      const startTime = performance.now();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .query({
          page: 1,
          limit: 50,
          category: 'ai'
        })
        .expect(200);

      const endTime = performance.now();
      const responseTime = endTime - startTime;

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeLessThanOrEqual(50);
      expect(responseTime).toBeLessThan(500); // API response within 500ms
    });

    test('should handle search queries efficiently', async () => {
      const startTime = performance.now();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product/search')
        .query({ q: 'performance test' })
        .expect(200);

      const endTime = performance.now();
      const responseTime = endTime - startTime;

      expect(Array.isArray(response.body)).toBe(true);
      expect(responseTime).toBeLessThan(300); // Search within 300ms
    });

    test('should handle analytics endpoints efficiently', async () => {
      const startTime = performance.now();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/analytics/dashboard')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ timeRange: '7d' })
        .expect(200);

      const endTime = performance.now();
      const responseTime = endTime - startTime;

      expect(response.body).toHaveProperty('totalRequests');
      expect(responseTime).toBeLessThan(1000); // Analytics within 1s
    });

    test('should handle concurrent API requests efficiently', async () => {
      const concurrentRequests = 10;
      const requests = Array(concurrentRequests).fill().map(() =>
        request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .query({ limit: 10 })
      );

      const startTime = performance.now();
      const responses = await Promise.all(requests);
      const endTime = performance.now();

      const totalTime = endTime - startTime;

      // All requests should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
      });

      expect(totalTime).toBeLessThan(1000); // All requests within 1s
    });
  });

  describe('File Operations Performance', () => {
    test('should handle file upload efficiently', async () => {
      const testFile = Buffer.alloc(1024 * 1024); // 1MB file
      
      const startTime = performance.now();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFile, 'performance-test.jpg')
        .expect(201);

      const endTime = performance.now();
      const uploadTime = endTime - startTime;

      expect(response.body).toHaveProperty('url');
      expect(uploadTime).toBeLessThan(2000); // 1MB upload within 2s
    });

    test('should handle file listing efficiently', async () => {
      const startTime = performance.now();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/files')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      const endTime = performance.now();
      const listTime = endTime - startTime;

      expect(response.body).toHaveProperty('files');
      expect(listTime).toBeLessThan(200); // File listing within 200ms
    });
  });

  describe('Memory and Resource Usage', () => {
    test('should maintain reasonable memory usage under load', async () => {
      const initialMemory = process.memoryUsage();

      // Perform memory-intensive operations
      const operations = Array(100).fill().map(async () => {
        return request(global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .query({ limit: 100 });
      });

      await Promise.all(operations);

      const finalMemory = process.memoryUsage();
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed;

      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });

    test('should handle garbage collection efficiently', async () => {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const initialMemory = process.memoryUsage();

      // Create temporary objects
      for (let i = 0; i < 1000; i++) {
        const tempData = Array(1000).fill(Math.random());
        // Process the data briefly
        tempData.reduce((sum, val) => sum + val, 0);
      }

      // Force garbage collection again
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage();
      
      // Memory should be cleaned up effectively
      expect(finalMemory.heapUsed).toBeLessThan(initialMemory.heapUsed + 10 * 1024 * 1024);
    });
  });
});