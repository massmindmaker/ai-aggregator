/**
 * Product CRUD Operations Unit Tests
 * Testing product creation, reading, updating, and deletion
 */

const request = require('supertest');
const mongoose = require('mongoose');

describe('Product CRUD Tests', () => {
  let authToken;
  let testUser;
  let testOrg;
  let testProduct;

  beforeAll(async () => {
    // Setup test user and authentication
    testUser = global.TestUtils.generateTestUser();
    testOrg = global.TestUtils.generateTestOrg();
    
    // Register and login test user
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
    // Clean up test data
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.collection('products').deleteMany({
        name: { $regex: /^Test Product/ }
      });
      await mongoose.connection.db.collection('users').deleteMany({
        email: { $regex: /@aiag\.com$/ }
      });
    }
  });

  describe('Product Creation', () => {
    test('should create a new product with valid data', async () => {
      testProduct = global.TestUtils.generateTestProduct();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(testProduct)
        .expect(201);

      expect(response.body).toHaveProperty('_id');
      expect(response.body.name).toBe(testProduct.name);
      expect(response.body.description).toBe(testProduct.description);
      expect(response.body.category).toBe(testProduct.category);
      expect(response.body.pricing).toBe(testProduct.pricing);
      
      // Store the created product ID for subsequent tests
      testProduct._id = response.body._id;
    });

    test('should validate required fields', async () => {
      const incompleteProduct = {
        description: 'Product without name'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(incompleteProduct)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('required');
    });

    test('should validate product name uniqueness', async () => {
      const duplicateProduct = {
        name: testProduct.name,
        description: 'Duplicate product name'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(duplicateProduct)
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('already exists');
    });

    test('should require authentication for product creation', async () => {
      const productData = global.TestUtils.generateTestProduct();

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .send(productData)
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Product Retrieval', () => {
    test('should get all products', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get('/product')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      
      const createdProduct = response.body.find(p => p._id === testProduct._id);
      expect(createdProduct).toBeDefined();
    });

    test('should get product by ID', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${testProduct._id}`)
        .expect(200);

      expect(response.body._id).toBe(testProduct._id);
      expect(response.body.name).toBe(testProduct.name);
    });

    test('should handle non-existent product ID', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${fakeId}`)
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    test('should filter products by category', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product?category=${testProduct.category}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      response.body.forEach(product => {
        expect(product.category).toBe(testProduct.category);
      });
    });

    test('should search products by name', async () => {
      const searchTerm = testProduct.name.split(' ')[0]; // Use first word for search
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/search?q=${searchTerm}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });
  });

  describe('Product Update', () => {
    test('should update product with valid data', async () => {
      const updateData = {
        description: 'Updated product description',
        pricing: 'Premium'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/product/${testProduct._id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.description).toBe(updateData.description);
      expect(response.body.pricing).toBe(updateData.pricing);
      expect(response.body.name).toBe(testProduct.name); // Name should remain unchanged
    });

    test('should require authentication for product update', async () => {
      const updateData = {
        description: 'Unauthorized update attempt'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/product/${testProduct._id}`)
        .send(updateData)
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('should validate owner permissions for update', async () => {
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
      const updateData = {
        description: 'Unauthorized update by another user'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/product/${testProduct._id}`)
        .set('Authorization', `Bearer ${anotherToken}`)
        .send(updateData)
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('permission');
    });

    test('should handle partial updates', async () => {
      const updateData = {
        pricing: 'Enterprise'
      };

      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .put(`/product/${testProduct._id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(response.body.pricing).toBe(updateData.pricing);
      // Other fields should remain unchanged
      expect(response.body.name).toBe(testProduct.name);
    });
  });

  describe('Product Deletion', () => {
    let productToDelete;

    beforeEach(async () => {
      // Create a product specifically for deletion tests
      productToDelete = global.TestUtils.generateTestProduct();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .post('/product')
        .set('Authorization', `Bearer ${authToken}`)
        .send(productToDelete);

      productToDelete._id = response.body._id;
    });

    test('should delete product with valid ID', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/product/${productToDelete._id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('deleted');

      // Verify product is actually deleted
      await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${productToDelete._id}`)
        .expect(404);
    });

    test('should require authentication for product deletion', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/product/${productToDelete._id}`)
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    test('should validate owner permissions for deletion', async () => {
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
        .delete(`/product/${productToDelete._id}`)
        .set('Authorization', `Bearer ${anotherToken}`)
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('permission');
    });

    test('should handle non-existent product deletion', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/product/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('not found');
    });

    test('should handle soft delete for products with dependencies', async () => {
      // This test assumes products might have dependencies that prevent hard deletion
      // Implementation would depend on business logic
      
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .delete(`/product/${productToDelete._id}?soft=true`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('message');
      
      // Verify product is soft deleted (marked as inactive but still exists)
      const checkResponse = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${productToDelete._id}`)
        .set('Authorization', `Bearer ${authToken}`);

      if (checkResponse.status === 200) {
        expect(checkResponse.body.isActive).toBe(false);
      }
    });
  });

  describe('Product Statistics', () => {
    test('should get product view statistics', async () => {
      const response = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${testProduct._id}/stats`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('views');
      expect(response.body).toHaveProperty('likes');
      expect(typeof response.body.views).toBe('number');
      expect(typeof response.body.likes).toBe('number');
    });

    test('should increment product views', async () => {
      const initialStats = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${testProduct._id}/stats`)
        .set('Authorization', `Bearer ${authToken}`);

      // View the product
      await request(global.TEST_CONFIG.LOCAL_URL)
        .post(`/product/${testProduct._id}/view`)
        .expect(200);

      const updatedStats = await request(global.TEST_CONFIG.LOCAL_URL)
        .get(`/product/${testProduct._id}/stats`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(updatedStats.body.views).toBe(initialStats.body.views + 1);
    });
  });
});