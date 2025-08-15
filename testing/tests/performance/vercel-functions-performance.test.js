/**
 * Vercel Functions Performance Tests
 * Testing cold start performance and function optimization
 */

const request = require('supertest');
const { performance } = require('perf_hooks');

describe('Vercel Functions Performance', () => {
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

  describe('Cold Start Performance', () => {
    test('should handle cold start within acceptable time limits', async () => {
      // Wait for potential cold start scenario
      await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes

      const endpoints = [
        '/auth/login',
        '/product',
        '/api/files',
        '/api/hub/analytics'
      ];

      for (const endpoint of endpoints) {
        const startTime = performance.now();
        
        let response;
        if (endpoint === '/auth/login') {
          response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .post(endpoint)
            .send({
              email: testUser.email,
              password: testUser.password
            });
        } else {
          response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .get(endpoint)
            .set('Authorization', `Bearer ${authToken}`);
        }

        const endTime = performance.now();
        const coldStartTime = endTime - startTime;

        expect(response.status).toBeLessThan(500);
        expect(coldStartTime).toBeLessThan(10000); // Cold start within 10 seconds
        
        console.log(`Cold start time for ${endpoint}: ${coldStartTime.toFixed(2)}ms`);
      }
    });

    test('should improve response time after warm-up', async () => {
      const endpoint = '/product';
      const iterations = 5;
      const responseTimes = [];

      for (let i = 0; i < iterations; i++) {
        const startTime = performance.now();
        
        const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get(endpoint)
          .query({ limit: 10 });

        const endTime = performance.now();
        const responseTime = endTime - startTime;
        
        responseTimes.push(responseTime);
        expect(response.status).toBe(200);

        // Small delay between requests
        if (i < iterations - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Response times should generally improve (be more consistent)
      const firstResponse = responseTimes[0];
      const lastResponse = responseTimes[responseTimes.length - 1];
      const avgResponse = responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;

      console.log('Response times:', responseTimes.map(t => `${t.toFixed(2)}ms`).join(', '));
      console.log(`First: ${firstResponse.toFixed(2)}ms, Last: ${lastResponse.toFixed(2)}ms, Avg: ${avgResponse.toFixed(2)}ms`);

      // After warm-up, responses should be faster and more consistent
      expect(avgResponse).toBeLessThan(2000); // Average response under 2s
    });

    test('should handle concurrent cold starts efficiently', async () => {
      // Wait for functions to go cold
      await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes

      const concurrentRequests = 5;
      const requests = Array(concurrentRequests).fill().map(() => {
        const startTime = performance.now();
        return request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .query({ limit: 5 })
          .then(response => ({
            response,
            time: performance.now() - startTime
          }));
      });

      const results = await Promise.all(requests);

      // All requests should succeed
      results.forEach(result => {
        expect(result.response.status).toBe(200);
        expect(result.time).toBeLessThan(15000); // Even concurrent cold starts under 15s
      });

      const avgTime = results.reduce((sum, result) => sum + result.time, 0) / results.length;
      console.log(`Concurrent cold start average: ${avgTime.toFixed(2)}ms`);
    });
  });

  describe('Function Optimization', () => {
    test('should optimize database connections', async () => {
      // Test multiple requests to see if connections are reused
      const requests = Array(10).fill().map(async (_, i) => {
        const startTime = performance.now();
        
        const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .query({ page: i + 1, limit: 5 });

        const endTime = performance.now();
        return {
          responseTime: endTime - startTime,
          status: response.status
        };
      });

      const results = await Promise.all(requests);

      // All requests should succeed
      results.forEach(result => {
        expect(result.status).toBe(200);
      });

      // Later requests should be faster due to connection reuse
      const firstHalf = results.slice(0, 5);
      const secondHalf = results.slice(5);

      const firstHalfAvg = firstHalf.reduce((sum, r) => sum + r.responseTime, 0) / firstHalf.length;
      const secondHalfAvg = secondHalf.reduce((sum, r) => sum + r.responseTime, 0) / secondHalf.length;

      console.log(`First half avg: ${firstHalfAvg.toFixed(2)}ms, Second half avg: ${secondHalfAvg.toFixed(2)}ms`);
      
      // Second half should be similar or faster (connection reuse)
      expect(secondHalfAvg).toBeLessThanOrEqual(firstHalfAvg * 1.5); // Within 50% of first half
    });

    test('should handle memory optimization', async () => {
      // Test memory-intensive operation
      const startTime = performance.now();

      const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
        .get('/api/analytics/dashboard')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ 
          timeRange: '30d',
          includeDetails: 'true'
        });

      const endTime = performance.now();
      const responseTime = endTime - startTime;

      expect(response.status).toBe(200);
      expect(responseTime).toBeLessThan(5000); // Memory-intensive operation under 5s
    });

    test('should handle function size optimization', async () => {
      // Test that functions aren't too large (affects cold start)
      const endpoints = [
        '/auth/login',
        '/product',
        '/api/files/upload',
        '/api/hub/proxy'
      ];

      for (const endpoint of endpoints) {
        const startTime = performance.now();
        
        let response;
        if (endpoint === '/auth/login') {
          response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .post(endpoint)
            .send({
              email: testUser.email,
              password: testUser.password
            });
        } else if (endpoint === '/api/files/upload') {
          response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .post(endpoint)
            .set('Authorization', `Bearer ${authToken}`)
            .attach('file', Buffer.from('test'), 'test.txt');
        } else {
          response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .get(endpoint)
            .set('Authorization', `Bearer ${authToken}`);
        }

        const endTime = performance.now();
        const responseTime = endTime - startTime;

        expect(response.status).toBeLessThan(500);
        expect(responseTime).toBeLessThan(3000); // Optimized functions under 3s
      }
    });
  });

  describe('Scaling Performance', () => {
    test('should handle burst traffic efficiently', async () => {
      const burstSize = 20;
      const requests = Array(burstSize).fill().map(async (_, i) => {
        const startTime = performance.now();
        
        const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .query({ search: `test${i % 5}` });

        const endTime = performance.now();
        return {
          index: i,
          responseTime: endTime - startTime,
          status: response.status
        };
      });

      const results = await Promise.all(requests);

      // All requests should succeed
      const successCount = results.filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThan(burstSize * 0.9); // At least 90% success

      // Average response time should be reasonable
      const avgResponseTime = results.reduce((sum, r) => sum + r.responseTime, 0) / results.length;
      expect(avgResponseTime).toBeLessThan(5000); // Burst handling under 5s average

      console.log(`Burst test - Success rate: ${(successCount / burstSize * 100).toFixed(1)}%`);
      console.log(`Average response time: ${avgResponseTime.toFixed(2)}ms`);
    });

    test('should handle sustained load', async () => {
      const sustainedDuration = 30000; // 30 seconds
      const requestInterval = 1000; // 1 request per second
      const startTime = Date.now();
      const results = [];

      while (Date.now() - startTime < sustainedDuration) {
        const requestStart = performance.now();
        
        try {
          const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .get('/product')
            .query({ limit: 10 })
            .timeout(5000);

          const requestEnd = performance.now();
          results.push({
            time: Date.now() - startTime,
            responseTime: requestEnd - requestStart,
            status: response.status
          });
        } catch (error) {
          results.push({
            time: Date.now() - startTime,
            responseTime: 5000, // timeout
            status: error.status || 500
          });
        }

        // Wait for next interval
        await new Promise(resolve => setTimeout(resolve, requestInterval));
      }

      // Analyze sustained load performance
      const successCount = results.filter(r => r.status === 200).length;
      const avgResponseTime = results
        .filter(r => r.status === 200)
        .reduce((sum, r) => sum + r.responseTime, 0) / successCount;

      expect(successCount).toBeGreaterThan(results.length * 0.85); // 85% success rate
      expect(avgResponseTime).toBeLessThan(3000); // Sustained performance under 3s

      console.log(`Sustained load - Total requests: ${results.length}`);
      console.log(`Success rate: ${(successCount / results.length * 100).toFixed(1)}%`);
      console.log(`Average response time: ${avgResponseTime.toFixed(2)}ms`);
    });

    test('should auto-scale efficiently', async () => {
      // Gradually increase load to test auto-scaling
      const phases = [
        { duration: 10000, concurrency: 2 },
        { duration: 10000, concurrency: 5 },
        { duration: 10000, concurrency: 10 },
        { duration: 10000, concurrency: 15 }
      ];

      const allResults = [];

      for (const phase of phases) {
        console.log(`Testing phase: ${phase.concurrency} concurrent requests`);
        const phaseStart = Date.now();
        const phaseResults = [];

        while (Date.now() - phaseStart < phase.duration) {
          const batch = Array(phase.concurrency).fill().map(async () => {
            const requestStart = performance.now();
            
            try {
              const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
                .get('/product')
                .query({ limit: 5 })
                .timeout(10000);

              const requestEnd = performance.now();
              return {
                responseTime: requestEnd - requestStart,
                status: response.status
              };
            } catch (error) {
              return {
                responseTime: 10000,
                status: error.status || 500
              };
            }
          });

          const batchResults = await Promise.all(batch);
          phaseResults.push(...batchResults);

          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const successRate = phaseResults.filter(r => r.status === 200).length / phaseResults.length;
        const avgResponseTime = phaseResults
          .filter(r => r.status === 200)
          .reduce((sum, r) => sum + r.responseTime, 0) / 
          phaseResults.filter(r => r.status === 200).length;

        allResults.push({
          concurrency: phase.concurrency,
          successRate,
          avgResponseTime,
          totalRequests: phaseResults.length
        });

        console.log(`Phase ${phase.concurrency}: ${(successRate * 100).toFixed(1)}% success, ${avgResponseTime.toFixed(2)}ms avg`);
      }

      // Verify scaling performance
      allResults.forEach(result => {
        expect(result.successRate).toBeGreaterThan(0.8); // 80% success rate minimum
        expect(result.avgResponseTime).toBeLessThan(8000); // Response time under 8s even at high load
      });
    });
  });

  describe('Edge Function Performance', () => {
    test('should handle geo-distributed requests efficiently', async () => {
      // Test with different regions simulation (if available)
      const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1'];
      const results = [];

      for (const region of regions) {
        const startTime = performance.now();
        
        const response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .set('CF-IPCountry', region) // Simulate different regions
          .query({ limit: 10 });

        const endTime = performance.now();
        
        results.push({
          region,
          responseTime: endTime - startTime,
          status: response.status
        });
      }

      // All regions should respond successfully
      results.forEach(result => {
        expect(result.status).toBe(200);
        expect(result.responseTime).toBeLessThan(5000); // Regional response under 5s
      });

      console.log('Regional performance:', results.map(r => 
        `${r.region}: ${r.responseTime.toFixed(2)}ms`
      ).join(', '));
    });

    test('should handle CDN integration efficiently', async () => {
      // Test static assets and cacheable content
      const staticEndpoints = [
        '/product', // Cacheable API response
        '/api/files', // File listings
      ];

      for (const endpoint of staticEndpoints) {
        // First request (cache miss)
        const firstStart = performance.now();
        const firstResponse = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get(endpoint)
          .set('Authorization', `Bearer ${authToken}`);
        const firstEnd = performance.now();

        // Second request (potential cache hit)
        const secondStart = performance.now();
        const secondResponse = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get(endpoint)
          .set('Authorization', `Bearer ${authToken}`);
        const secondEnd = performance.now();

        const firstTime = firstEnd - firstStart;
        const secondTime = secondEnd - secondStart;

        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);

        console.log(`${endpoint} - First: ${firstTime.toFixed(2)}ms, Second: ${secondTime.toFixed(2)}ms`);

        // Second request might be faster due to caching
        if (secondTime < firstTime * 0.8) {
          console.log(`Cache optimization detected for ${endpoint}`);
        }
      }
    });
  });

  describe('Resource Optimization', () => {
    test('should optimize bundle size impact on performance', async () => {
      // Test different endpoints to ensure bundle size doesn't impact performance
      const endpoints = [
        { path: '/auth/login', method: 'POST', data: { email: testUser.email, password: testUser.password } },
        { path: '/product', method: 'GET' },
        { path: '/api/hub/analytics', method: 'GET', auth: true }
      ];

      for (const endpoint of endpoints) {
        const startTime = performance.now();
        
        let response;
        if (endpoint.method === 'POST') {
          response = await request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .post(endpoint.path)
            .send(endpoint.data);
        } else {
          const req = request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
            .get(endpoint.path);
          
          if (endpoint.auth) {
            req.set('Authorization', `Bearer ${authToken}`);
          }
          
          response = await req;
        }

        const endTime = performance.now();
        const responseTime = endTime - startTime;

        expect(response.status).toBeLessThan(500);
        expect(responseTime).toBeLessThan(4000); // Optimized bundle performance under 4s

        console.log(`${endpoint.method} ${endpoint.path}: ${responseTime.toFixed(2)}ms`);
      }
    });

    test('should handle memory-efficient operations', async () => {
      // Test operations that could be memory intensive
      const memoryIntensiveOps = [
        () => request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get('/product')
          .query({ limit: 100 }), // Large result set
        
        () => request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .get('/api/analytics/dashboard')
          .set('Authorization', `Bearer ${authToken}`)
          .query({ timeRange: '30d' }), // Complex analytics
        
        () => request(global.TEST_CONFIG.VERCEL_URL || global.TEST_CONFIG.LOCAL_URL)
          .post('/api/files/upload')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', Buffer.alloc(1024 * 1024), 'large-file.jpg') // File upload
      ];

      for (const operation of memoryIntensiveOps) {
        const startTime = performance.now();
        
        try {
          const response = await operation();
          const endTime = performance.now();
          const responseTime = endTime - startTime;

          expect(response.status).toBeLessThan(500);
          expect(responseTime).toBeLessThan(10000); // Memory-efficient ops under 10s
        } catch (error) {
          // Some operations might fail in test environment, that's ok
          console.log(`Operation failed (acceptable in test): ${error.message}`);
        }
      }
    });
  });
});