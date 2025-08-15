/**
 * Vercel Blob Storage Integration Tests
 * Testing migration from Yandex Cloud to Vercel Blob Storage
 */

const request = require('supertest');
const { put, del, list, head } = require('@vercel/blob');
const axios = require('axios');

// Mock external dependencies for isolated testing
jest.mock('@vercel/blob');
jest.mock('axios');

describe('Vercel Blob Storage Integration', () => {
  let authToken;
  let testUser;

  beforeAll(async () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Blob Storage Operations', () => {
    test('should upload file to Vercel Blob Storage', async () => {
      const mockBlobResponse = {
        url: 'https://blob.vercel-storage.com/test-file-abc123.jpg',
        pathname: 'test-file-abc123.jpg',
        contentType: 'image/jpeg',
        size: 1024,
        uploadedAt: new Date().toISOString()
      };

      put.mockResolvedValue(mockBlobResponse);

      const testFile = Buffer.from('fake-image-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFile, 'test-image.jpg')
        .expect(201);

      expect(response.body).toHaveProperty('url');
      expect(response.body.url).toBe(mockBlobResponse.url);
      expect(put).toHaveBeenCalledWith(
        expect.stringContaining('test-image'),
        testFile,
        expect.objectContaining({
          access: 'public',
          contentType: 'image/jpeg'
        })
      );
    });

    test('should list blob files for user', async () => {
      const mockListResponse = {
        blobs: [
          {
            url: 'https://blob.vercel-storage.com/file1-abc123.jpg',
            pathname: 'file1-abc123.jpg',
            size: 1024,
            uploadedAt: new Date().toISOString()
          },
          {
            url: 'https://blob.vercel-storage.com/file2-def456.png',
            pathname: 'file2-def456.png',
            size: 2048,
            uploadedAt: new Date().toISOString()
          }
        ],
        hasMore: false,
        cursor: null
      };

      list.mockResolvedValue(mockListResponse);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/list')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('files');
      expect(Array.isArray(response.body.files)).toBe(true);
      expect(response.body.files).toHaveLength(2);
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: expect.stringContaining(testUser.id)
        })
      );
    });

    test('should get blob file metadata', async () => {
      const testUrl = 'https://blob.vercel-storage.com/test-file-abc123.jpg';
      const mockHeadResponse = {
        url: testUrl,
        size: 1024,
        uploadedAt: new Date().toISOString(),
        contentType: 'image/jpeg'
      };

      head.mockResolvedValue(mockHeadResponse);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/metadata')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ url: testUrl })
        .expect(200);

      expect(response.body).toHaveProperty('size');
      expect(response.body).toHaveProperty('contentType');
      expect(response.body).toHaveProperty('uploadedAt');
      expect(head).toHaveBeenCalledWith(testUrl);
    });

    test('should delete blob file', async () => {
      const testUrl = 'https://blob.vercel-storage.com/test-file-abc123.jpg';
      del.mockResolvedValue({ success: true });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete('/api/blob/delete')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ url: testUrl })
        .expect(204);

      expect(del).toHaveBeenCalledWith(testUrl);
    });

    test('should handle blob storage errors', async () => {
      put.mockRejectedValue(new Error('Blob storage quota exceeded'));

      const testFile = Buffer.from('test-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFile, 'test.txt')
        .expect(507);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('storage');
    });
  });

  describe('Migration from Yandex Cloud', () => {
    test('should migrate single file from Yandex Cloud to Vercel Blob', async () => {
      const yandexUrl = 'https://aiagweb.storage.yandexcloud.net/uploads/test-file.jpg';
      const mockFileBuffer = Buffer.from('migrated-file-content');
      
      // Mock Yandex Cloud file download
      axios.get.mockResolvedValue({
        data: mockFileBuffer,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '1024'
        }
      });

      // Mock Vercel Blob upload
      const mockBlobResponse = {
        url: 'https://blob.vercel-storage.com/migrated-test-file-xyz789.jpg',
        pathname: 'migrated-test-file-xyz789.jpg',
        contentType: 'image/jpeg',
        size: 1024
      };
      put.mockResolvedValue(mockBlobResponse);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/migrate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          sourceUrl: yandexUrl,
          filename: 'test-file.jpg'
        })
        .expect(201);

      expect(response.body).toHaveProperty('newUrl');
      expect(response.body).toHaveProperty('originalUrl');
      expect(response.body.originalUrl).toBe(yandexUrl);
      expect(response.body.newUrl).toBe(mockBlobResponse.url);

      expect(axios.get).toHaveBeenCalledWith(yandexUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      expect(put).toHaveBeenCalledWith(
        expect.stringContaining('test-file'),
        mockFileBuffer,
        expect.objectContaining({
          contentType: 'image/jpeg'
        })
      );
    });

    test('should handle bulk migration from Yandex Cloud', async () => {
      const filesToMigrate = [
        {
          sourceUrl: 'https://aiagweb.storage.yandexcloud.net/uploads/file1.jpg',
          filename: 'file1.jpg'
        },
        {
          sourceUrl: 'https://aiagweb.storage.yandexcloud.net/uploads/file2.png',
          filename: 'file2.png'
        }
      ];

      // Mock successful downloads
      axios.get.mockImplementation((url) => {
        return Promise.resolve({
          data: Buffer.from(`content-for-${url}`),
          headers: {
            'content-type': url.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
            'content-length': '1024'
          }
        });
      });

      // Mock successful uploads
      put.mockImplementation((filename) => {
        return Promise.resolve({
          url: `https://blob.vercel-storage.com/${filename}-xyz789.ext`,
          pathname: `${filename}-xyz789.ext`,
          size: 1024
        });
      });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/migrate-bulk')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ files: filesToMigrate })
        .expect(202);

      expect(response.body).toHaveProperty('migrationId');
      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('started');
    });

    test('should track migration progress', async () => {
      const migrationId = 'migration-12345';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/api/blob/migration/${migrationId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('progress');
      expect(response.body).toHaveProperty('totalFiles');
      expect(response.body).toHaveProperty('completedFiles');
      expect(response.body).toHaveProperty('failedFiles');
    });

    test('should handle migration failures gracefully', async () => {
      const yandexUrl = 'https://aiagweb.storage.yandexcloud.net/non-existent-file.jpg';
      
      // Mock 404 error from Yandex Cloud
      axios.get.mockRejectedValue({
        response: { status: 404 },
        message: 'File not found'
      });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/migrate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          sourceUrl: yandexUrl,
          filename: 'non-existent-file.jpg'
        })
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    test('should validate Yandex Cloud URLs before migration', async () => {
      const invalidUrls = [
        'https://invalid-domain.com/file.jpg',
        'not-a-url',
        'https://aiagweb.storage.yandexcloud.net/../../../etc/passwd'
      ];

      for (const invalidUrl of invalidUrls) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/blob/migrate')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            sourceUrl: invalidUrl,
            filename: 'test.jpg'
          })
          .expect(400);

        expect(response.body).toHaveProperty('error');
      }
    });

    test('should preserve file metadata during migration', async () => {
      const yandexUrl = 'https://aiagweb.storage.yandexcloud.net/uploads/metadata-test.jpg';
      const mockFileBuffer = Buffer.from('file-with-metadata');
      
      axios.get.mockResolvedValue({
        data: mockFileBuffer,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '2048',
          'last-modified': 'Wed, 21 Oct 2023 07:28:00 GMT',
          'etag': '"abc123def456"'
        }
      });

      const mockBlobResponse = {
        url: 'https://blob.vercel-storage.com/metadata-test-xyz789.jpg',
        pathname: 'metadata-test-xyz789.jpg',
        contentType: 'image/jpeg',
        size: 2048
      };
      put.mockResolvedValue(mockBlobResponse);

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/migrate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          sourceUrl: yandexUrl,
          filename: 'metadata-test.jpg',
          preserveMetadata: true
        })
        .expect(201);

      expect(response.body).toHaveProperty('metadata');
      expect(response.body.metadata).toHaveProperty('originalSize');
      expect(response.body.metadata).toHaveProperty('lastModified');
    });
  });

  describe('Blob Storage Security', () => {
    test('should enforce user isolation in blob storage', async () => {
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

      // Try to access first user's files with second user's token
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/list')
        .set('Authorization', `Bearer ${anotherToken}`)
        .query({ userId: testUser.id })
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('access denied');
    });

    test('should validate file paths to prevent directory traversal', async () => {
      const maliciousFilenames = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32\\config\\sam',
        '/etc/hosts',
        'C:\\Windows\\System32\\drivers\\etc\\hosts'
      ];

      for (const filename of maliciousFilenames) {
        const response = await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/blob/upload')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', Buffer.from('test'), filename)
          .expect(400);

        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toContain('invalid filename');
      }
    });

    test('should enforce file size limits', async () => {
      const largeFile = Buffer.alloc(100 * 1024 * 1024); // 100MB
      put.mockRejectedValue(new Error('File too large'));

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', largeFile, 'large-file.jpg')
        .expect(413);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('file size');
    });

    test('should scan uploaded files for malware', async () => {
      // Mock virus scanner detection
      const suspiciousFile = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/blob/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', suspiciousFile, 'eicar.txt')
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('security threat');
    });
  });

  describe('Blob Storage Performance', () => {
    test('should handle concurrent uploads efficiently', async () => {
      const concurrentUploads = 10;
      const mockResponses = Array(concurrentUploads).fill().map((_, i) => ({
        url: `https://blob.vercel-storage.com/concurrent-${i}-abc123.txt`,
        pathname: `concurrent-${i}-abc123.txt`,
        size: 1024
      }));

      put.mockImplementation((filename) => {
        const index = filename.match(/concurrent-(\d+)/)?.[1] || 0;
        return Promise.resolve(mockResponses[index]);
      });

      const uploadPromises = Array(concurrentUploads).fill().map((_, i) =>
        request(global.TEST_CONFIG.LOCAL_URL)
          .post('/api/blob/upload')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', Buffer.from(`content-${i}`), `concurrent-${i}.txt`)
      );

      const startTime = Date.now();
      const responses = await Promise.all(uploadPromises);
      const endTime = Date.now();

      // All uploads should succeed
      responses.forEach(response => {
        expect(response.status).toBe(201);
      });

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(5000);
    });

    test('should optimize blob listing for large directories', async () => {
      const largeFileList = Array(1000).fill().map((_, i) => ({
        url: `https://blob.vercel-storage.com/file-${i}-abc123.jpg`,
        pathname: `file-${i}-abc123.jpg`,
        size: 1024,
        uploadedAt: new Date().toISOString()
      }));

      list.mockResolvedValue({
        blobs: largeFileList.slice(0, 50), // Return paginated results
        hasMore: true,
        cursor: 'cursor-50'
      });

      const startTime = Date.now();
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/list')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ limit: 50 })
        .expect(200);
      const endTime = Date.now();

      expect(response.body.files).toHaveLength(50);
      expect(response.body).toHaveProperty('hasMore');
      expect(response.body).toHaveProperty('cursor');
      expect(endTime - startTime).toBeLessThan(1000); // Should be fast
    });

    test('should implement efficient caching for frequently accessed files', async () => {
      const testUrl = 'https://blob.vercel-storage.com/cached-file-abc123.jpg';
      
      head.mockResolvedValue({
        url: testUrl,
        size: 1024,
        contentType: 'image/jpeg',
        uploadedAt: new Date().toISOString()
      });

      // First request
      const response1 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/metadata')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ url: testUrl })
        .expect(200);

      // Second request (should use cache)
      const response2 = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/metadata')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ url: testUrl })
        .expect(200);

      expect(response1.body).toEqual(response2.body);
      
      // Check cache headers
      if (response2.headers['x-cache']) {
        expect(response2.headers['x-cache']).toBe('HIT');
      }
    });
  });

  describe('Blob Storage Monitoring', () => {
    test('should track storage usage per user', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/usage')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('totalSize');
      expect(response.body).toHaveProperty('fileCount');
      expect(response.body).toHaveProperty('quota');
      expect(response.body).toHaveProperty('usagePercentage');
      expect(typeof response.body.totalSize).toBe('number');
      expect(typeof response.body.fileCount).toBe('number');
    });

    test('should provide storage analytics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/analytics')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ period: '30d' })
        .expect(200);

      expect(response.body).toHaveProperty('uploadTrends');
      expect(response.body).toHaveProperty('fileTypes');
      expect(response.body).toHaveProperty('sizeDistribution');
      expect(response.body).toHaveProperty('accessPatterns');
    });

    test('should alert on storage quota approaching limit', async () => {
      // Mock approaching quota limit
      list.mockResolvedValue({
        blobs: Array(900).fill().map((_, i) => ({
          url: `https://blob.vercel-storage.com/file-${i}.jpg`,
          size: 10 * 1024 * 1024 // 10MB each
        })),
        hasMore: false
      });

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/blob/usage')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      if (response.body.usagePercentage > 80) {
        expect(response.body).toHaveProperty('warning');
        expect(response.body.warning).toContain('quota');
      }
    });
  });
});