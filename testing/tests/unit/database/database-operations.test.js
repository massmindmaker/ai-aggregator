/**
 * Database Operations Unit Tests
 * Testing MongoDB Atlas and Vercel Postgres operations
 */

const { MongoClient } = require('mongodb');
const { Pool } = require('pg');

describe('Database Operations Unit Tests', () => {
  let mongoClient;
  let pgPool;

  beforeAll(async () => {
    // MongoDB connection
    mongoClient = new MongoClient(process.env.MONGODB_TEST_URI);
    await mongoClient.connect();

    // PostgreSQL connection
    pgPool = new Pool({
      connectionString: process.env.POSTGRES_TEST_URI,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
  });

  afterAll(async () => {
    if (mongoClient) {
      await mongoClient.close();
    }
    if (pgPool) {
      await pgPool.end();
    }
  });

  describe('MongoDB Atlas Operations', () => {
    let db;
    let usersCollection;

    beforeAll(() => {
      db = mongoClient.db('aiag_test');
      usersCollection = db.collection('users');
    });

    beforeEach(async () => {
      // Clean up test data
      await usersCollection.deleteMany({ email: { $regex: /test.*@aiag\.com/ } });
    });

    test('should connect to MongoDB Atlas', async () => {
      expect(mongoClient.topology.isConnected()).toBe(true);
    });

    test('should create user document', async () => {
      const testUser = {
        email: 'test-create@aiag.com',
        username: 'testcreate',
        password: 'hashedpassword',
        createdAt: new Date(),
        verified: false
      };

      const result = await usersCollection.insertOne(testUser);
      
      expect(result.insertedId).toBeTruthy();
      expect(result.acknowledged).toBe(true);

      const foundUser = await usersCollection.findOne({ _id: result.insertedId });
      expect(foundUser.email).toBe(testUser.email);
    });

    test('should update user document', async () => {
      const testUser = {
        email: 'test-update@aiag.com',
        username: 'testupdate',
        verified: false
      };

      const insertResult = await usersCollection.insertOne(testUser);
      
      const updateResult = await usersCollection.updateOne(
        { _id: insertResult.insertedId },
        { $set: { verified: true, updatedAt: new Date() } }
      );

      expect(updateResult.modifiedCount).toBe(1);

      const updatedUser = await usersCollection.findOne({ _id: insertResult.insertedId });
      expect(updatedUser.verified).toBe(true);
      expect(updatedUser.updatedAt).toBeTruthy();
    });

    test('should delete user document', async () => {
      const testUser = {
        email: 'test-delete@aiag.com',
        username: 'testdelete'
      };

      const insertResult = await usersCollection.insertOne(testUser);
      
      const deleteResult = await usersCollection.deleteOne({ _id: insertResult.insertedId });
      
      expect(deleteResult.deletedCount).toBe(1);

      const foundUser = await usersCollection.findOne({ _id: insertResult.insertedId });
      expect(foundUser).toBeNull();
    });

    test('should handle concurrent operations', async () => {
      const operations = Array.from({ length: 10 }, (_, i) => 
        usersCollection.insertOne({
          email: `test-concurrent-${i}@aiag.com`,
          username: `testconcurrent${i}`,
          createdAt: new Date()
        })
      );

      const results = await Promise.all(operations);
      
      expect(results.length).toBe(10);
      results.forEach(result => {
        expect(result.acknowledged).toBe(true);
        expect(result.insertedId).toBeTruthy();
      });
    });

    test('should handle unique constraint violations', async () => {
      const testUser = {
        email: 'test-unique@aiag.com',
        username: 'testunique'
      };

      // Create unique index if it doesn't exist
      await usersCollection.createIndex({ email: 1 }, { unique: true });

      // First insert should succeed
      await usersCollection.insertOne(testUser);

      // Second insert with same email should fail
      await expect(usersCollection.insertOne(testUser)).rejects.toThrow();
    });

    test('should perform aggregation queries', async () => {
      // Insert test data
      const testUsers = Array.from({ length: 5 }, (_, i) => ({
        email: `test-agg-${i}@aiag.com`,
        username: `testagg${i}`,
        verified: i % 2 === 0,
        createdAt: new Date()
      }));

      await usersCollection.insertMany(testUsers);

      // Perform aggregation
      const stats = await usersCollection.aggregate([
        { $match: { email: { $regex: /test-agg.*@aiag\.com/ } } },
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            verifiedUsers: {
              $sum: { $cond: ['$verified', 1, 0] }
            }
          }
        }
      ]).toArray();

      expect(stats[0].totalUsers).toBe(5);
      expect(stats[0].verifiedUsers).toBe(3);
    });

    test('should handle large document operations', async () => {
      const largeDocument = {
        email: 'test-large@aiag.com',
        username: 'testlarge',
        metadata: {
          preferences: new Array(1000).fill(null).map((_, i) => ({
            key: `pref_${i}`,
            value: `value_${i}`,
            enabled: i % 2 === 0
          }))
        }
      };

      const result = await usersCollection.insertOne(largeDocument);
      expect(result.acknowledged).toBe(true);

      const foundDocument = await usersCollection.findOne({ _id: result.insertedId });
      expect(foundDocument.metadata.preferences).toHaveLength(1000);
    });
  });

  describe('PostgreSQL Operations', () => {
    beforeEach(async () => {
      // Clean up test data
      await pgPool.query("DELETE FROM api_requests WHERE endpoint LIKE 'test-%'");
      await pgPool.query("DELETE FROM api_statistics WHERE api_name LIKE 'test-%'");
    });

    test('should connect to PostgreSQL', async () => {
      const client = await pgPool.connect();
      expect(client).toBeTruthy();
      client.release();
    });

    test('should insert api request log', async () => {
      const requestLog = {
        endpoint: 'test-endpoint',
        method: 'POST',
        status_code: 200,
        response_time: 150,
        ip_address: '127.0.0.1',
        user_agent: 'test-agent',
        timestamp: new Date()
      };

      const query = `
        INSERT INTO api_requests (endpoint, method, status_code, response_time, ip_address, user_agent, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `;

      const result = await pgPool.query(query, [
        requestLog.endpoint,
        requestLog.method,
        requestLog.status_code,
        requestLog.response_time,
        requestLog.ip_address,
        requestLog.user_agent,
        requestLog.timestamp
      ]);

      expect(result.rows[0].id).toBeTruthy();
    });

    test('should update api statistics', async () => {
      const insertQuery = `
        INSERT INTO api_statistics (api_name, total_requests, avg_response_time, success_rate)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `;

      const insertResult = await pgPool.query(insertQuery, [
        'test-api',
        100,
        200,
        0.95
      ]);

      const updateQuery = `
        UPDATE api_statistics 
        SET total_requests = $1, avg_response_time = $2, success_rate = $3
        WHERE id = $4
        RETURNING *
      `;

      const updateResult = await pgPool.query(updateQuery, [
        150,
        180,
        0.97,
        insertResult.rows[0].id
      ]);

      expect(updateResult.rows[0].total_requests).toBe(150);
      expect(updateResult.rows[0].avg_response_time).toBe(180);
      expect(updateResult.rows[0].success_rate).toBe(0.97);
    });

    test('should handle concurrent connections', async () => {
      const queries = Array.from({ length: 20 }, (_, i) => 
        pgPool.query(
          "INSERT INTO api_requests (endpoint, method, status_code) VALUES ($1, $2, $3)",
          [`test-concurrent-${i}`, 'GET', 200]
        )
      );

      const results = await Promise.all(queries);
      
      expect(results.length).toBe(20);
      results.forEach(result => {
        expect(result.rowCount).toBe(1);
      });
    });

    test('should perform complex queries with joins', async () => {
      // Insert test data
      await pgPool.query(`
        INSERT INTO api_statistics (api_name, total_requests, avg_response_time)
        VALUES ('test-join-api', 500, 150)
      `);

      await pgPool.query(`
        INSERT INTO api_requests (endpoint, method, status_code, response_time)
        VALUES ('test-join-api/users', 'GET', 200, 120),
               ('test-join-api/posts', 'GET', 200, 180),
               ('test-join-api/users', 'POST', 201, 200)
      `);

      const query = `
        SELECT 
          s.api_name,
          s.total_requests as stat_total,
          COUNT(r.id) as actual_requests,
          AVG(r.response_time) as actual_avg_time
        FROM api_statistics s
        LEFT JOIN api_requests r ON r.endpoint LIKE s.api_name || '%'
        WHERE s.api_name = 'test-join-api'
        GROUP BY s.api_name, s.total_requests
      `;

      const result = await pgPool.query(query);
      
      expect(result.rows[0].api_name).toBe('test-join-api');
      expect(parseInt(result.rows[0].actual_requests)).toBe(3);
    });

    test('should handle transaction rollback', async () => {
      const client = await pgPool.connect();

      try {
        await client.query('BEGIN');
        
        await client.query(`
          INSERT INTO api_statistics (api_name, total_requests)
          VALUES ('test-transaction', 100)
        `);

        // Simulate error condition
        await client.query(`
          INSERT INTO api_statistics (api_name, total_requests)
          VALUES ('test-transaction', 'invalid')
        `);

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        
        // Verify rollback worked
        const result = await client.query(
          "SELECT * FROM api_statistics WHERE api_name = 'test-transaction'"
        );
        expect(result.rows.length).toBe(0);
      } finally {
        client.release();
      }
    });

    test('should handle connection pool limits', async () => {
      const connections = Array.from({ length: 25 }, async () => {
        const client = await pgPool.connect();
        await new Promise(resolve => setTimeout(resolve, 100));
        client.release();
      });

      // Should not throw errors even with many concurrent connections
      await expect(Promise.all(connections)).resolves.not.toThrow();
    });
  });

  describe('Cross-Database Consistency', () => {
    test('should maintain data consistency between MongoDB and PostgreSQL', async () => {
      const testData = {
        userId: 'test-consistency-user',
        apiName: 'test-consistency-api',
        timestamp: new Date()
      };

      // Insert user in MongoDB
      const mongoDb = mongoClient.db('aiag_test');
      const usersCollection = mongoDb.collection('users');
      
      const userResult = await usersCollection.insertOne({
        _id: testData.userId,
        email: 'test-consistency@aiag.com',
        createdAt: testData.timestamp
      });

      // Insert API usage in PostgreSQL
      const pgResult = await pgPool.query(`
        INSERT INTO api_requests (user_id, endpoint, timestamp)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [testData.userId, testData.apiName, testData.timestamp]);

      // Verify both operations succeeded
      expect(userResult.acknowledged).toBe(true);
      expect(pgResult.rows[0].id).toBeTruthy();

      // Verify data can be correlated
      const user = await usersCollection.findOne({ _id: testData.userId });
      const apiRequest = await pgPool.query(
        'SELECT * FROM api_requests WHERE user_id = $1',
        [testData.userId]
      );

      expect(user).toBeTruthy();
      expect(apiRequest.rows.length).toBe(1);
      expect(apiRequest.rows[0].user_id).toBe(testData.userId);
    });

    test('should handle cross-database transaction-like operations', async () => {
      const testUserId = 'test-cross-transaction';
      let mongoSuccess = false;
      let pgSuccess = false;

      try {
        // MongoDB operation
        const mongoDb = mongoClient.db('aiag_test');
        const usersCollection = mongoDb.collection('users');
        
        await usersCollection.insertOne({
          _id: testUserId,
          email: 'test-cross@aiag.com'
        });
        mongoSuccess = true;

        // PostgreSQL operation
        await pgPool.query(`
          INSERT INTO api_requests (user_id, endpoint)
          VALUES ($1, $2)
        `, [testUserId, 'test-cross-endpoint']);
        pgSuccess = true;

      } catch (error) {
        // Cleanup on failure
        if (mongoSuccess) {
          const mongoDb = mongoClient.db('aiag_test');
          await mongoDb.collection('users').deleteOne({ _id: testUserId });
        }
        if (pgSuccess) {
          await pgPool.query('DELETE FROM api_requests WHERE user_id = $1', [testUserId]);
        }
        throw error;
      }

      expect(mongoSuccess).toBe(true);
      expect(pgSuccess).toBe(true);
    });
  });

  describe('Database Performance', () => {
    test('should complete MongoDB operations within time limits', async () => {
      const mongoDb = mongoClient.db('aiag_test');
      const testCollection = mongoDb.collection('performance_test');

      const startTime = Date.now();

      // Insert 100 documents
      const docs = Array.from({ length: 100 }, (_, i) => ({
        index: i,
        data: `test-data-${i}`,
        timestamp: new Date()
      }));

      await testCollection.insertMany(docs);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within 2 seconds
      expect(duration).toBeLessThan(2000);

      // Cleanup
      await testCollection.deleteMany({ data: { $regex: /test-data-/ } });
    });

    test('should complete PostgreSQL operations within time limits', async () => {
      const startTime = Date.now();

      // Insert 100 records
      const insertPromises = Array.from({ length: 100 }, (_, i) =>
        pgPool.query(`
          INSERT INTO api_requests (endpoint, method, status_code)
          VALUES ($1, $2, $3)
        `, [`test-perf-${i}`, 'GET', 200])
      );

      await Promise.all(insertPromises);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within 3 seconds
      expect(duration).toBeLessThan(3000);

      // Cleanup
      await pgPool.query("DELETE FROM api_requests WHERE endpoint LIKE 'test-perf-%'");
    });
  });
});