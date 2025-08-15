/**
 * File Upload and Management Unit Tests
 * Testing file upload functionality with Vercel Blob Storage migration
 */

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { put, del, head } = require('@vercel/blob');

// Mock Vercel Blob Storage
jest.mock('@vercel/blob');

describe('File Upload Tests', () => {
  let authToken;
  let testUser;
  let mockBlobResponse;

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

    // Mock Vercel Blob responses
    mockBlobResponse = {
      url: 'https://blob.vercel-storage.com/test-file-abc123.jpg',
      pathname: 'test-file-abc123.jpg',
      contentType: 'image/jpeg',
      contentDisposition: 'inline; filename="test-file.jpg"'
    };
  });

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
    put.mockResolvedValue(mockBlobResponse);
    head.mockResolvedValue({ 
      size: 1024,
      uploadedAt: new Date(),
      ...mockBlobResponse 
    });
    del.mockResolvedValue({ success: true });
  });

  describe('Image Upload', () => {
    test('should upload valid image file', async () => {
      // Create a mock image file buffer
      const mockImageBuffer = Buffer.from('fake-image-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockImageBuffer, {
          filename: 'test-image.jpg',
          contentType: 'image/jpeg'
        })
        .expect(200);

      expect(response.body).toHaveProperty('url');
      expect(response.body).toHaveProperty('filename');
      expect(response.body).toHaveProperty('contentType');
      expect(response.body.contentType).toBe('image/jpeg');
      expect(put).toHaveBeenCalledTimes(1);
    });

    test('should validate file size limits', async () => {
      const largeMockBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB file
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', largeMockBuffer, {
          filename: 'large-image.jpg',
          contentType: 'image/jpeg'
        })
        .expect(413);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('file size');
    });

    test('should validate file types', async () => {
      const mockBuffer = Buffer.from('fake-executable-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockBuffer, {
          filename: 'malicious.exe',
          contentType: 'application/executable'
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('file type');
    });

    test('should require authentication for upload', async () => {
      const mockBuffer = Buffer.from('fake-image-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .attach('file', mockBuffer, {
          filename: 'test.jpg',
          contentType: 'image/jpeg'
        })
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('should handle missing file in request', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('file');
    });
  });

  describe('Profile Avatar Upload', () => {
    test('should upload and update user avatar', async () => {
      const mockAvatarBuffer = Buffer.from('fake-avatar-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', mockAvatarBuffer, {
          filename: 'avatar.jpg',
          contentType: 'image/jpeg'
        })
        .expect(200);

      expect(response.body).toHaveProperty('avatarUrl');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.avatarUrl).toBe(response.body.avatarUrl);
      expect(put).toHaveBeenCalledTimes(1);
    });

    test('should resize avatar image', async () => {
      const mockLargeAvatarBuffer = Buffer.from('fake-large-avatar-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', mockLargeAvatarBuffer, {
          filename: 'large-avatar.jpg',
          contentType: 'image/jpeg'
        })
        .expect(200);

      expect(response.body).toHaveProperty('avatarUrl');
      // Should verify that image was processed/resized
      expect(put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Buffer),
        expect.objectContaining({
          access: 'public',
          contentType: 'image/jpeg'
        })
      );
    });

    test('should replace existing avatar', async () => {
      // Upload first avatar
      const firstAvatarBuffer = Buffer.from('first-avatar-data');
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', firstAvatarBuffer, {
          filename: 'first-avatar.jpg',
          contentType: 'image/jpeg'
        });

      // Upload second avatar (should replace first)
      const secondAvatarBuffer = Buffer.from('second-avatar-data');
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', secondAvatarBuffer, {
          filename: 'second-avatar.jpg',
          contentType: 'image/jpeg'
        })
        .expect(200);

      expect(response.body).toHaveProperty('avatarUrl');
      // Should verify that old avatar was deleted
      expect(del).toHaveBeenCalled();
    });
  });

  describe('Document Upload', () => {
    test('should upload PDF document', async () => {
      const mockPdfBuffer = Buffer.from('fake-pdf-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/document')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('document', mockPdfBuffer, {
          filename: 'test-document.pdf',
          contentType: 'application/pdf'
        })
        .expect(200);

      expect(response.body).toHaveProperty('url');
      expect(response.body).toHaveProperty('filename');
      expect(response.body.contentType).toBe('application/pdf');
      expect(put).toHaveBeenCalledTimes(1);
    });

    test('should handle CSV file upload', async () => {
      const csvContent = 'name,email,age\nJohn,john@test.com,30\nJane,jane@test.com,25';
      const mockCsvBuffer = Buffer.from(csvContent);
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/csv')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('csv', mockCsvBuffer, {
          filename: 'test-data.csv',
          contentType: 'text/csv'
        })
        .expect(200);

      expect(response.body).toHaveProperty('url');
      expect(response.body).toHaveProperty('parsedData');
      expect(Array.isArray(response.body.parsedData)).toBe(true);
      expect(response.body.parsedData).toHaveLength(2);
    });
  });

  describe('File Retrieval', () => {
    let uploadedFileUrl;

    beforeEach(async () => {
      // Upload a test file for retrieval tests
      const mockBuffer = Buffer.from('test-file-content');
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockBuffer, {
          filename: 'test-file.jpg',
          contentType: 'image/jpeg'
        });

      uploadedFileUrl = response.body.url;
    });

    test('should retrieve file metadata', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/api/files/info?url=${encodeURIComponent(uploadedFileUrl)}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('size');
      expect(response.body).toHaveProperty('contentType');
      expect(response.body).toHaveProperty('uploadedAt');
      expect(head).toHaveBeenCalledTimes(1);
    });

    test('should handle non-existent file metadata request', async () => {
      const fakeUrl = 'https://blob.vercel-storage.com/fake-file.jpg';
      head.mockRejectedValue(new Error('File not found'));

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/api/files/info?url=${encodeURIComponent(fakeUrl)}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('File Deletion', () => {
    let fileToDelete;

    beforeEach(async () => {
      // Upload a file for deletion tests
      const mockBuffer = Buffer.from('file-to-delete');
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockBuffer, {
          filename: 'delete-me.jpg',
          contentType: 'image/jpeg'
        });

      fileToDelete = response.body;
    });

    test('should delete file with valid URL', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete('/api/files/delete')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ url: fileToDelete.url })
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('deleted');
      expect(del).toHaveBeenCalledWith(fileToDelete.url);
    });

    test('should require authentication for file deletion', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete('/api/files/delete')
        .send({ url: fileToDelete.url })
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('should validate file ownership before deletion', async () => {
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

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete('/api/files/delete')
        .set('Authorization', `Bearer ${anotherToken}`)
        .send({ url: fileToDelete.url })
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('permission');
    });
  });

  describe('Vercel Blob Migration', () => {
    test('should handle Vercel Blob Storage errors gracefully', async () => {
      put.mockRejectedValue(new Error('Blob storage error'));
      
      const mockBuffer = Buffer.from('test-data');
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/upload')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', mockBuffer, {
          filename: 'test.jpg',
          contentType: 'image/jpeg'
        })
        .expect(500);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('storage');
    });

    test('should migrate from Yandex Cloud URLs', async () => {
      const yandexCloudUrl = 'https://aiagweb.storage.yandexcloud.net/old-file.jpg';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/migrate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ oldUrl: yandexCloudUrl })
        .expect(200);

      expect(response.body).toHaveProperty('newUrl');
      expect(response.body.newUrl).toContain('blob.vercel-storage.com');
      expect(response.body).toHaveProperty('migrated');
      expect(response.body.migrated).toBe(true);
    });

    test('should validate URL format for migration', async () => {
      const invalidUrl = 'not-a-valid-url';
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/files/migrate')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ oldUrl: invalidUrl })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('URL');
    });
  });
});