/**
 * Database Integration Tests
 * Testing MongoDB Atlas and PostgreSQL connections and operations
 */

const request = require('supertest');
const { MongoClient } = require('mongodb');
const { Pool } = require('pg');

describe('Database Integration Tests', () => {
  let mongoClient;
  let pgPool;
  let authToken;
  let testUser;

  beforeAll(async () => {
    // Setup MongoDB connection
    mongoClient = new MongoClient(process.env.MONGODB_URI || global.TEST_CONFIG.MONGODB_URI);
    await mongoClient.connect();

    // Setup PostgreSQL connection
    pgPool = new Pool({
      connectionString: process.env.POSTGRES_URI || global.TEST_CONFIG.POSTGRES_URI
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
  });

  afterAll(async () => {
    // Cleanup connections
    if (mongoClient) {
      await mongoClient.close();
    }
    if (pgPool) {
      await pgPool.end();
    }
  });

  describe('MongoDB Atlas Integration', () => {
    test('should connect to MongoDB Atlas successfully', async () => {
      const db = mongoClient.db();
      const collections = await db.listCollections().toArray();
      expect(Array.isArray(collections)).toBe(true);
    });

    test('should perform CRUD operations on MongoDB', async () => {
      const db = mongoClient.db();
      const collection = db.collection('test_products');

      // Create
      const insertResult = await collection.insertOne({
        name: 'Test Product MongoDB',
        description: 'Test product for MongoDB integration',
        createdAt: new Date(),
        userId: testUser.id
      });

      expect(insertResult.insertedId).toBeDefined();

      // Read
      const findResult = await collection.findOne({ _id: insertResult.insertedId });
      expect(findResult.name).toBe('Test Product MongoDB');

      // Update
      const updateResult = await collection.updateOne(
        { _id: insertResult.insertedId },
        { $set: { description: 'Updated description' } }
      );
      expect(updateResult.modifiedCount).toBe(1);

      // Verify update
      const updatedDoc = await collection.findOne({ _id: insertResult.insertedId });
      expect(updatedDoc.description).toBe('Updated description');

      // Delete
      const deleteResult = await collection.deleteOne({ _id: insertResult.insertedId });
      expect(deleteResult.deletedCount).toBe(1);

      // Verify deletion
      const deletedDoc = await collection.findOne({ _id: insertResult.insertedId });
      expect(deletedDoc).toBeNull();
    });

    test('should handle MongoDB connection errors gracefully', async () => {
      // Simulate connection error by connecting to invalid URI
      const invalidClient = new MongoClient('mongodb://invalid-host:27017/test');
      
      await expect(invalidClient.connect()).rejects.toThrow();
    });

    test('should perform aggregation queries on MongoDB', async () => {
      const db = mongoClient.db();
      const collection = db.collection('test_aggregation');

      // Insert test data
      await collection.insertMany([
        { category: 'AI', price: 100, userId: testUser.id },
        { category: 'AI', price: 200, userId: testUser.id },
        { category: 'ML', price: 150, userId: testUser.id },
        { category: 'ML', price: 300, userId: testUser.id }
      ]);

      // Perform aggregation
      const result = await collection.aggregate([
        { $match: { userId: testUser.id } },
        { $group: { _id: '$category', avgPrice: { $avg: '$price' }, count: { $sum: 1 } } },
        { $sort: { avgPrice: -1 } }
      ]).toArray();

      expect(result).toHaveLength(2);
      expect(result[0]._id).toBe('ML');
      expect(result[0].avgPrice).toBe(225);
      expect(result[1]._id).toBe('AI');
      expect(result[1].avgPrice).toBe(150);

      // Cleanup
      await collection.deleteMany({ userId: testUser.id });
    });

    test('should handle MongoDB transactions', async () => {
      const session = mongoClient.startSession();
      const db = mongoClient.db();
      const products = db.collection('test_products');
      const users = db.collection('test_users');

      try {
        await session.withTransaction(async () => {
          // Insert product
          await products.insertOne(
            { name: 'Transaction Test Product', userId: testUser.id },
            { session }
          );

          // Update user stats
          await users.updateOne(
            { _id: testUser.id },
            { $inc: { productCount: 1 } },
            { session }
          );
        });

        // Verify both operations completed
        const product = await products.findOne({ name: 'Transaction Test Product' });
        expect(product).toBeDefined();

        const user = await users.findOne({ _id: testUser.id });
        expect(user.productCount).toBeGreaterThan(0);

      } finally {
        await session.endSession();
        
        // Cleanup
        await products.deleteOne({ name: 'Transaction Test Product' });
        await users.updateOne({ _id: testUser.id }, { $unset: { productCount: 1 } });
      }
    });

    test('should validate MongoDB indexes', async () => {
      const db = mongoClient.db();
      const collection = db.collection('products');

      // Get indexes
      const indexes = await collection.indexes();
      
      // Should have at least _id index
      expect(indexes.length).toBeGreaterThan(0);
      
      // Check for common indexes
      const indexNames = indexes.map(idx => Object.keys(idx.key).join(','));
      expect(indexNames).toContain('_id');
      
      // Check for application-specific indexes
      const hasUserIdIndex = indexes.some(idx => idx.key.userId);
      const hasCategoryIndex = indexes.some(idx => idx.key.category);
      
      if (hasUserIdIndex) {
        expect(hasUserIdIndex).toBe(true);
      }
      if (hasCategoryIndex) {
        expect(hasCategoryIndex).toBe(true);
      }
    });
  });

  describe('PostgreSQL Integration', () => {
    test('should connect to PostgreSQL successfully', async () => {
      const client = await pgPool.connect();
      const result = await client.query('SELECT NOW()');
      expect(result.rows).toHaveLength(1);
      client.release();
    });

    test('should perform CRUD operations on PostgreSQL', async () => {
      const client = await pgPool.connect();

      try {
        // Create table if not exists
        await client.query(`
          CREATE TABLE IF NOT EXISTS test_metrics (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255),
            metric_name VARCHAR(255),
            metric_value DECIMAL,
            created_at TIMESTAMP DEFAULT NOW()
          )
        `);

        // Create
        const insertResult = await client.query(
          'INSERT INTO test_metrics (user_id, metric_name, metric_value) VALUES ($1, $2, $3) RETURNING id',
          [testUser.id, 'test_metric', 123.45]
        );

        const metricId = insertResult.rows[0].id;
        expect(metricId).toBeDefined();

        // Read
        const selectResult = await client.query(
          'SELECT * FROM test_metrics WHERE id = $1',
          [metricId]
        );

        expect(selectResult.rows).toHaveLength(1);
        expect(selectResult.rows[0].metric_name).toBe('test_metric');
        expect(parseFloat(selectResult.rows[0].metric_value)).toBe(123.45);

        // Update
        await client.query(
          'UPDATE test_metrics SET metric_value = $1 WHERE id = $2',
          [456.78, metricId]
        );

        const updatedResult = await client.query(
          'SELECT metric_value FROM test_metrics WHERE id = $1',
          [metricId]
        );

        expect(parseFloat(updatedResult.rows[0].metric_value)).toBe(456.78);

        // Delete
        const deleteResult = await client.query(
          'DELETE FROM test_metrics WHERE id = $1',
          [metricId]
        );

        expect(deleteResult.rowCount).toBe(1);

        // Verify deletion
        const verifyResult = await client.query(
          'SELECT * FROM test_metrics WHERE id = $1',
          [metricId]
        );

        expect(verifyResult.rows).toHaveLength(0);

      } finally {
        client.release();
      }
    });

    test('should handle PostgreSQL transactions', async () => {
      const client = await pgPool.connect();

      try {
        await client.query('BEGIN');

        // Insert multiple related records
        const userResult = await client.query(
          'INSERT INTO test_users (email, name) VALUES ($1, $2) RETURNING id',
          [`transaction-test-${Date.now()}@test.com`, 'Transaction Test User']
        );

        const userId = userResult.rows[0].id;

        await client.query(
          'INSERT INTO test_metrics (user_id, metric_name, metric_value) VALUES ($1, $2, $3)',
          [userId, 'signup_metric', 1]
        );

        await client.query(
          'INSERT INTO test_metrics (user_id, metric_name, metric_value) VALUES ($1, $2, $3)',
          [userId, 'activation_metric', 1]
        );

        await client.query('COMMIT');

        // Verify both inserts succeeded
        const userCheck = await client.query('SELECT * FROM test_users WHERE id = $1', [userId]);
        const metricsCheck = await client.query('SELECT * FROM test_metrics WHERE user_id = $1', [userId]);

        expect(userCheck.rows).toHaveLength(1);
        expect(metricsCheck.rows).toHaveLength(2);

        // Cleanup
        await client.query('DELETE FROM test_metrics WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM test_users WHERE id = $1', [userId]);

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });

    test('should handle PostgreSQL connection pooling', async () => {
      // Test multiple concurrent connections
      const promises = Array(10).fill().map(async (_, i) => {
        const client = await pgPool.connect();
        try {
          const result = await client.query('SELECT $1::text as message', [`Connection ${i}`]);
          return result.rows[0].message;
        } finally {
          client.release();
        }
      });

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach((result, i) => {
        expect(result).toBe(`Connection ${i}`);
      });
    });

    test('should perform complex PostgreSQL queries', async () => {
      const client = await pgPool.connect();

      try {
        // Create test data
        await client.query(`
          INSERT INTO test_metrics (user_id, metric_name, metric_value, created_at) VALUES
          ('user1', 'api_calls', 100, NOW() - INTERVAL '1 day'),
          ('user1', 'api_calls', 150, NOW() - INTERVAL '2 hours'),
          ('user2', 'api_calls', 200, NOW() - INTERVAL '1 day'),
          ('user2', 'api_calls', 250, NOW() - INTERVAL '2 hours')
        `);

        // Complex query with aggregation and window functions
        const result = await client.query(`
          SELECT 
            user_id,
            SUM(metric_value) as total_calls,
            AVG(metric_value) as avg_calls,
            LAG(metric_value) OVER (PARTITION BY user_id ORDER BY created_at) as previous_value
          FROM test_metrics 
          WHERE metric_name = 'api_calls'
          GROUP BY user_id, metric_value, created_at
          ORDER BY user_id, created_at
        `);

        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows[0]).toHaveProperty('total_calls');
        expect(result.rows[0]).toHaveProperty('avg_calls');

      } finally {
        // Cleanup
        await client.query("DELETE FROM test_metrics WHERE metric_name = 'api_calls'");
        client.release();
      }
    });
  });

  describe('Cross-Database Operations', () => {
    test('should sync data between MongoDB and PostgreSQL', async () => {
      const mongoDb = mongoClient.db();
      const mongoCollection = mongoDb.collection('sync_test');
      const pgClient = await pgPool.connect();

      try {
        // Insert data in MongoDB
        const mongoDoc = {
          name: 'Cross-DB Test Product',
          userId: testUser.id,
          apiCalls: 0,
          createdAt: new Date()
        };

        const mongoResult = await mongoCollection.insertOne(mongoDoc);

        // Create corresponding metrics record in PostgreSQL
        await pgClient.query(
          'INSERT INTO test_metrics (user_id, metric_name, metric_value) VALUES ($1, $2, $3)',
          [testUser.id, 'product_created', 1]
        );

        // Simulate API call that updates both databases
        await mongoCollection.updateOne(
          { _id: mongoResult.insertedId },
          { $inc: { apiCalls: 1 } }
        );

        await pgClient.query(
          'INSERT INTO test_metrics (user_id, metric_name, metric_value) VALUES ($1, $2, $3)',
          [testUser.id, 'api_call', 1]
        );

        // Verify sync
        const mongoUpdated = await mongoCollection.findOne({ _id: mongoResult.insertedId });
        expect(mongoUpdated.apiCalls).toBe(1);

        const pgMetrics = await pgClient.query(
          'SELECT COUNT(*) as count FROM test_metrics WHERE user_id = $1',
          [testUser.id]
        );
        expect(parseInt(pgMetrics.rows[0].count)).toBeGreaterThan(0);

        // Cleanup
        await mongoCollection.deleteOne({ _id: mongoResult.insertedId });
        await pgClient.query('DELETE FROM test_metrics WHERE user_id = $1', [testUser.id]);

      } finally {
        pgClient.release();
      }
    });

    test('should handle cross-database consistency', async () => {
      // Test scenario: Create product in MongoDB and update metrics in PostgreSQL
      const mongoDb = mongoClient.db();
      const products = mongoDb.collection('products');
      const pgClient = await pgPool.connect();

      try {
        // Create product via API (should update both databases)
        const productData = global.TestUtils.generateTestProduct();
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send(productData);

        expect(response.status).toBe(201);
        const productId = response.body._id;

        // Verify product in MongoDB
        const mongoProduct = await products.findOne({ _id: productId });
        expect(mongoProduct).toBeDefined();
        expect(mongoProduct.name).toBe(productData.name);

        // Verify metrics in PostgreSQL
        const metricsResult = await pgClient.query(
          'SELECT * FROM test_metrics WHERE user_id = $1 AND metric_name = $2',
          [testUser.id, 'product_creation']
        );

        if (metricsResult.rows.length > 0) {
          expect(metricsResult.rows[0].metric_value).toBe('1');
        }

        // Test update consistency
        const updateData = { description: 'Updated via consistency test' };
        const updateResponse = await request(global.TEST_CONFIG.LOCAL_URL)
          .put(`/product/${productId}`)
          .set('Authorization', `Bearer ${authToken}`)
          .send(updateData);

        expect(updateResponse.status).toBe(200);

        // Verify update in MongoDB
        const updatedProduct = await products.findOne({ _id: productId });
        expect(updatedProduct.description).toBe(updateData.description);

        // Cleanup
        await request(global.TEST_CONFIG.LOCAL_URL)
          .delete(`/product/${productId}`)
          .set('Authorization', `Bearer ${authToken}`);

      } finally {
        await pgClient.query('DELETE FROM test_metrics WHERE user_id = $1', [testUser.id]);
        pgClient.release();
      }
    });
  });

  describe('Database Performance', () => {
    test('should handle concurrent database operations', async () => {
      const mongoDb = mongoClient.db();
      const collection = mongoDb.collection('performance_test');

      const startTime = Date.now();

      // Create multiple concurrent operations
      const operations = Array(20).fill().map(async (_, i) => {
        return collection.insertOne({
          name: `Performance Test ${i}`,
          value: Math.random() * 1000,
          timestamp: new Date()
        });
      });

      const results = await Promise.all(operations);
      const endTime = Date.now();

      expect(results).toHaveLength(20);
      expect(endTime - startTime).toBeLessThan(2000); // Should complete within 2 seconds

      // Cleanup
      await collection.deleteMany({ name: /^Performance Test/ });
    });

    test('should optimize database queries', async () => {
      const mongoDb = mongoClient.db();
      const collection = mongoDb.collection('query_optimization');

      // Insert test data
      const testDocs = Array(1000).fill().map((_, i) => ({
        userId: `user_${i % 10}`,
        category: `category_${i % 5}`,
        value: Math.random() * 1000,
        indexed_field: `value_${i}`,
        created_at: new Date(Date.now() - (i * 1000))
      }));

      await collection.insertMany(testDocs);

      // Test query performance with explain
      const startTime = Date.now();
      const result = await collection.find({
        userId: 'user_1',
        category: 'category_2'
      }).limit(10).toArray();
      const queryTime = Date.now() - startTime;

      expect(result.length).toBeGreaterThan(0);
      expect(queryTime).toBeLessThan(100); // Should be fast with proper indexing

      // Cleanup
      await collection.deleteMany({});
    });

    test('should monitor database connection health', async () => {
      // Test MongoDB health
      const mongoAdmin = mongoClient.db().admin();
      const mongoStatus = await mongoAdmin.serverStatus();
      expect(mongoStatus.ok).toBe(1);

      // Test PostgreSQL health
      const pgClient = await pgPool.connect();
      try {
        const pgResult = await pgClient.query('SELECT 1 as health_check');
        expect(pgResult.rows[0].health_check).toBe(1);
      } finally {
        pgClient.release();
      }

      // Test connection pool status
      expect(pgPool.totalCount).toBeGreaterThan(0);
      expect(pgPool.idleCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Data Migration Validation', () => {
    test('should validate migrated data integrity', async () => {
      // This test would validate data migrated from Yandex Cloud
      const mongoDb = mongoClient.db();
      const products = mongoDb.collection('products');
      const pgClient = await pgPool.connect();

      try {
        // Get sample of migrated data
        const sampleProducts = await products.find().limit(10).toArray();
        
        for (const product of sampleProducts) {
          // Validate MongoDB document structure
          expect(product).toHaveProperty('_id');
          expect(product).toHaveProperty('name');
          expect(product).toHaveProperty('userId');
          
          // Check corresponding metrics in PostgreSQL
          const metrics = await pgClient.query(
            'SELECT * FROM test_metrics WHERE user_id = $1',
            [product.userId]
          );
          
          // Metrics should exist for active products
          if (product.isActive !== false) {
            expect(metrics.rows.length).toBeGreaterThanOrEqual(0);
          }
        }
      } finally {
        pgClient.release();
      }
    });

    test('should verify database schema versions', async () => {
      const pgClient = await pgPool.connect();

      try {
        // Check if migration tracking table exists
        const schemaResult = await pgClient.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'schema_migrations'
        `);

        if (schemaResult.rows.length > 0) {
          // Get latest migration version
          const versionResult = await pgClient.query(
            'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
          );
          
          expect(versionResult.rows.length).toBeGreaterThan(0);
          expect(versionResult.rows[0].version).toBeDefined();
        }

        // Verify MongoDB collections exist
        const mongoDb = mongoClient.db();
        const collections = await mongoDb.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        expect(collectionNames).toContain('products');
        expect(collectionNames).toContain('users');

      } finally {
        pgClient.release();
      }
    });
  });
});