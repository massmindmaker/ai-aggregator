/**
 * Frontend-Backend Integration Tests
 * Testing full integration between React frontend and Node.js backend
 */

const request = require('supertest');
const puppeteer = require('puppeteer');
const path = require('path');

describe('Frontend-Backend Integration', () => {
  let browser;
  let page;
  let authToken;
  let testUser;

  beforeAll(async () => {
    // Setup browser for frontend testing
    browser = await puppeteer.launch({
      headless: process.env.NODE_ENV === 'production',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    // Setup test user
    testUser = global.TestUtils.generateTestUser();
    
    // Register user via API
    await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/register')
      .send(testUser);

    // Login via API to get token
    const loginResponse = await request(global.TEST_CONFIG.LOCAL_URL)
      .post('/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password
      });

    authToken = loginResponse.body.token;
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  beforeEach(async () => {
    // Clear browser storage before each test
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  describe('Authentication Flow', () => {
    test('should complete full login flow from frontend to backend', async () => {
      // Navigate to login page
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      
      // Wait for page to load
      await page.waitForSelector('[data-testid="login-form"]');

      // Fill login form
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);

      // Submit form
      await page.click('[data-testid="login-button"]');

      // Wait for redirect to dashboard
      await page.waitForNavigation();
      
      // Verify we're on dashboard
      expect(page.url()).toContain('/dashboard');
      
      // Verify user info is displayed
      await page.waitForSelector('[data-testid="user-avatar"]');
      const userEmail = await page.$eval('[data-testid="user-email"]', el => el.textContent);
      expect(userEmail).toBe(testUser.email);

      // Verify API token is stored
      const token = await page.evaluate(() => localStorage.getItem('authToken'));
      expect(token).toBeTruthy();
    });

    test('should handle login errors from backend', async () => {
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');

      // Try invalid credentials
      await page.type('[data-testid="email-input"]', 'invalid@email.com');
      await page.type('[data-testid="password-input"]', 'wrongpassword');
      await page.click('[data-testid="login-button"]');

      // Wait for error message
      await page.waitForSelector('[data-testid="error-message"]');
      const errorText = await page.$eval('[data-testid="error-message"]', el => el.textContent);
      expect(errorText).toContain('Invalid credentials');
    });

    test('should logout and clear authentication', async () => {
      // Login first
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();

      // Logout
      await page.click('[data-testid="user-menu"]');
      await page.waitForSelector('[data-testid="logout-button"]');
      await page.click('[data-testid="logout-button"]');

      // Should redirect to home page
      await page.waitForNavigation();
      expect(page.url()).toContain('/');

      // Token should be cleared
      const token = await page.evaluate(() => localStorage.getItem('authToken'));
      expect(token).toBeFalsy();
    });
  });

  describe('Product Management Integration', () => {
    beforeEach(async () => {
      // Login before each test
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();
    });

    test('should create product from frontend and verify in backend', async () => {
      // Navigate to product creation
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products/new`);
      await page.waitForSelector('[data-testid="product-form"]');

      // Fill product form
      const productName = `Test Product ${Date.now()}`;
      await page.type('[data-testid="product-name"]', productName);
      await page.type('[data-testid="product-description"]', 'Integration test product');
      await page.select('[data-testid="product-category"]', 'machine-learning');
      await page.type('[data-testid="product-pricing"]', 'Free');

      // Submit form
      await page.click('[data-testid="create-product-button"]');

      // Wait for success message
      await page.waitForSelector('[data-testid="success-message"]');

      // Verify product was created via API
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product/search')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ q: productName });

      expect(response.status).toBe(200);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].name).toBe(productName);
    });

    test('should update product from frontend and sync with backend', async () => {
      // Create product via API first
      const productData = global.TestUtils.generateTestProduct();
      const createResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(productData);

      const productId = createResponse.body._id;

      // Navigate to product edit page
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products/${productId}/edit`);
      await page.waitForSelector('[data-testid="product-form"]');

      // Update product name
      await page.evaluate(() => document.querySelector('[data-testid="product-name"]').value = '');
      const updatedName = `Updated Product ${Date.now()}`;
      await page.type('[data-testid="product-name"]', updatedName);

      // Submit update
      await page.click('[data-testid="update-product-button"]');
      await page.waitForSelector('[data-testid="success-message"]');

      // Verify update via API
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${productId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe(updatedName);
    });

    test('should delete product from frontend and verify removal in backend', async () => {
      // Create product via API
      const productData = global.TestUtils.generateTestProduct();
      const createResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(productData);

      const productId = createResponse.body._id;

      // Navigate to product list
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products`);
      await page.waitForSelector('[data-testid="product-list"]');

      // Find and delete product
      await page.click(`[data-testid="product-${productId}-delete"]`);
      
      // Confirm deletion
      await page.waitForSelector('[data-testid="confirm-delete"]');
      await page.click('[data-testid="confirm-delete"]');

      // Wait for success message
      await page.waitForSelector('[data-testid="success-message"]');

      // Verify deletion via API
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${productId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('File Upload Integration', () => {
    beforeEach(async () => {
      // Login before each test
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();
    });

    test('should upload file from frontend and verify in backend', async () => {
      // Navigate to file upload page
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/files/upload`);
      await page.waitForSelector('[data-testid="file-upload-form"]');

      // Create test file
      const testFilePath = path.join(__dirname, 'test-file.txt');
      require('fs').writeFileSync(testFilePath, 'Test file content for integration test');

      // Upload file
      const fileInput = await page.$('[data-testid="file-input"]');
      await fileInput.uploadFile(testFilePath);

      // Submit upload
      await page.click('[data-testid="upload-button"]');

      // Wait for upload completion
      await page.waitForSelector('[data-testid="upload-success"]');

      // Get uploaded file URL
      const fileUrl = await page.$eval('[data-testid="file-url"]', el => el.textContent);

      // Verify file exists via API
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/api/files')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      const uploadedFile = response.body.files.find(f => f.url === fileUrl);
      expect(uploadedFile).toBeDefined();

      // Cleanup
      require('fs').unlinkSync(testFilePath);
    });

    test('should handle file upload errors in frontend', async () => {
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/files/upload`);
      await page.waitForSelector('[data-testid="file-upload-form"]');

      // Try to upload file that's too large (mock by changing file size limit)
      await page.evaluate(() => {
        window.MAX_FILE_SIZE = 1; // 1 byte limit
      });

      const testFilePath = path.join(__dirname, 'large-test-file.txt');
      require('fs').writeFileSync(testFilePath, 'This file is too large for the test');

      const fileInput = await page.$('[data-testid="file-input"]');
      await fileInput.uploadFile(testFilePath);

      await page.click('[data-testid="upload-button"]');

      // Wait for error message
      await page.waitForSelector('[data-testid="upload-error"]');
      const errorText = await page.$eval('[data-testid="upload-error"]', el => el.textContent);
      expect(errorText).toContain('file size');

      // Cleanup
      require('fs').unlinkSync(testFilePath);
    });
  });

  describe('Real-time Features Integration', () => {
    test('should receive real-time notifications', async () => {
      // Login
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();

      // Navigate to dashboard
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/dashboard`);
      await page.waitForSelector('[data-testid="notifications"]');

      // Trigger notification via API
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/api/notifications')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          type: 'info',
          message: 'Integration test notification',
          targetUser: testUser.id
        });

      // Wait for notification to appear in frontend
      await page.waitForSelector('[data-testid="notification-item"]', { timeout: 5000 });
      
      const notificationText = await page.$eval('[data-testid="notification-item"]', el => el.textContent);
      expect(notificationText).toContain('Integration test notification');
    });
  });

  describe('Search and Filtering Integration', () => {
    beforeEach(async () => {
      // Login and create test data
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();

      // Create test products via API
      const products = [
        { name: 'AI Search Engine', category: 'search', pricing: 'Free' },
        { name: 'ML Classifier', category: 'machine-learning', pricing: 'Premium' },
        { name: 'Data Processor', category: 'data-processing', pricing: 'Free' }
      ];

      for (const product of products) {
        await request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            ...product,
            description: `Test product: ${product.name}`
          });
      }
    });

    test('should search products from frontend and get backend results', async () => {
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products`);
      await page.waitForSelector('[data-testid="search-input"]');

      // Search for specific product
      await page.type('[data-testid="search-input"]', 'AI Search');
      await page.click('[data-testid="search-button"]');

      // Wait for results
      await page.waitForSelector('[data-testid="search-results"]');
      
      const results = await page.$$eval('[data-testid="product-card"]', cards => 
        cards.map(card => card.querySelector('[data-testid="product-name"]').textContent)
      );

      expect(results).toContain('AI Search Engine');
      expect(results.length).toBeGreaterThan(0);
    });

    test('should filter products by category', async () => {
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products`);
      await page.waitForSelector('[data-testid="category-filter"]');

      // Select machine learning category
      await page.select('[data-testid="category-filter"]', 'machine-learning');

      // Wait for filtered results
      await page.waitForSelector('[data-testid="filtered-results"]');
      
      const results = await page.$$eval('[data-testid="product-card"]', cards => 
        cards.map(card => card.querySelector('[data-testid="product-name"]').textContent)
      );

      expect(results).toContain('ML Classifier');
      expect(results).not.toContain('AI Search Engine');
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle backend errors gracefully in frontend', async () => {
      // Login
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();

      // Try to access non-existent product
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products/nonexistent-id`);
      
      // Should show 404 error
      await page.waitForSelector('[data-testid="error-404"]');
      const errorMessage = await page.$eval('[data-testid="error-message"]', el => el.textContent);
      expect(errorMessage).toContain('Product not found');
    });

    test('should handle network errors', async () => {
      // Login
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();

      // Simulate network failure
      await page.setOfflineMode(true);

      // Try to create product
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products/new`);
      await page.waitForSelector('[data-testid="product-form"]');
      await page.type('[data-testid="product-name"]', 'Network Test Product');
      await page.click('[data-testid="create-product-button"]');

      // Should show network error
      await page.waitForSelector('[data-testid="network-error"]');
      const errorMessage = await page.$eval('[data-testid="error-message"]', el => el.textContent);
      expect(errorMessage).toContain('network');

      // Restore network
      await page.setOfflineMode(false);
    });
  });

  describe('Performance Integration', () => {
    test('should load dashboard within acceptable time', async () => {
      const startTime = Date.now();
      
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();
      
      // Wait for dashboard to fully load
      await page.waitForSelector('[data-testid="dashboard-loaded"]');
      
      const loadTime = Date.now() - startTime;
      expect(loadTime).toBeLessThan(5000); // Should load within 5 seconds
    });

    test('should handle large product lists efficiently', async () => {
      // Create many products via API
      const products = Array(50).fill().map((_, i) => ({
        name: `Product ${i}`,
        description: `Description for product ${i}`,
        category: 'test',
        pricing: 'Free'
      }));

      await Promise.all(products.map(product => 
        request(global.TEST_CONFIG.LOCAL_URL)
          .post('/product')
          .set('Authorization', `Bearer ${authToken}`)
          .send(product)
      ));

      // Login and navigate to products
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/login`);
      await page.waitForSelector('[data-testid="login-form"]');
      await page.type('[data-testid="email-input"]', testUser.email);
      await page.type('[data-testid="password-input"]', testUser.password);
      await page.click('[data-testid="login-button"]');
      await page.waitForNavigation();

      const startTime = Date.now();
      await page.goto(`${global.TEST_CONFIG.FRONTEND_URL}/products`);
      await page.waitForSelector('[data-testid="product-list-loaded"]');
      const loadTime = Date.now() - startTime;

      expect(loadTime).toBeLessThan(3000); // Should load large list within 3 seconds
    });
  });
});