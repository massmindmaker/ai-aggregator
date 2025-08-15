/**
 * Test Data Seeding and Cleanup Scripts
 * Comprehensive test data management for AI Aggregator testing
 */

const { MongoClient } = require('mongodb');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const chalk = require('chalk');
const ora = require('ora');

class TestDataSeeder {
  constructor() {
    this.mongoClient = null;
    this.pgPool = null;
    this.seededData = {
      users: [],
      organizations: [],
      products: [],
      apiKeys: [],
      files: []
    };
  }

  async connect() {
    const spinner = ora('Connecting to databases...').start();

    try {
      // Connect to MongoDB
      this.mongoClient = new MongoClient(
        process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/aiag_test'
      );
      await this.mongoClient.connect();

      // Connect to PostgreSQL
      this.pgPool = new Pool({
        connectionString: process.env.POSTGRES_TEST_URI || 'postgresql://localhost:5432/aiag_hub_test',
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
      });

      spinner.succeed('Database connections established');
    } catch (error) {
      spinner.fail('Database connection failed');
      throw error;
    }
  }

  async disconnect() {
    if (this.mongoClient) {
      await this.mongoClient.close();
    }
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }

  async seedAll() {
    console.log(chalk.blue.bold('\n🌱 Starting comprehensive test data seeding...\n'));

    try {
      await this.connect();

      // Seed in dependency order
      await this.seedUsers();
      await this.seedOrganizations();
      await this.seedProducts();
      await this.seedAPIKeys();
      await this.seedFiles();
      await this.seedAnalyticsData();
      await this.seedContests();
      await this.seedRequests();

      console.log(chalk.green.bold('\n✅ All test data seeded successfully!\n'));
      
      // Save seeded data info for cleanup
      await this.saveSeededDataInfo();

    } catch (error) {
      console.error(chalk.red.bold('\n❌ Test data seeding failed:\n'), error.message);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async seedUsers() {
    const spinner = ora('Seeding users...').start();

    try {
      const db = this.mongoClient.db();
      const usersCollection = db.collection('users');

      const users = [
        {
          email: 'admin@aiag.com',
          username: 'admin',
          password: await bcrypt.hash('AdminPassword123!', 12),
          firstName: 'Admin',
          lastName: 'User',
          role: 'admin',
          verified: true,
          createdAt: new Date(),
          isTestData: true
        },
        {
          email: 'developer@aiag.com',
          username: 'developer',
          password: await bcrypt.hash('DevPassword123!', 12),
          firstName: 'Developer',
          lastName: 'User',
          role: 'developer',
          verified: true,
          createdAt: new Date(),
          isTestData: true
        },
        {
          email: 'user@aiag.com',
          username: 'testuser',
          password: await bcrypt.hash('UserPassword123!', 12),
          firstName: 'Test',
          lastName: 'User',
          role: 'user',
          verified: true,
          createdAt: new Date(),
          isTestData: true
        },
        // Load testing users
        ...Array.from({ length: 50 }, (_, i) => ({
          email: `loadtest${i}@aiag.com`,
          username: `loadtest${i}`,
          password: bcrypt.hashSync('LoadTest123!', 12),
          firstName: `LoadTest${i}`,
          lastName: 'User',
          role: 'user',
          verified: true,
          createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000), // Random date within last 30 days
          isTestData: true
        }))
      ];

      const result = await usersCollection.insertMany(users);
      this.seededData.users = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${users.length} users`);
    } catch (error) {
      spinner.fail('User seeding failed');
      throw error;
    }
  }

  async seedOrganizations() {
    const spinner = ora('Seeding organizations...').start();

    try {
      const db = this.mongoClient.db();
      const orgsCollection = db.collection('organizations');
      const usersCollection = db.collection('users');

      // Get some users to be organization owners
      const users = await usersCollection.find({ isTestData: true }).limit(10).toArray();

      const organizations = [
        {
          name: 'AI Research Labs',
          description: 'Leading AI research and development organization',
          website: 'https://airesearchlabs.com',
          industry: 'Technology',
          size: '51-200',
          ownerId: users[0]._id,
          members: [
            { userId: users[0]._id, role: 'owner', joinedAt: new Date() },
            { userId: users[1]._id, role: 'admin', joinedAt: new Date() },
            { userId: users[2]._id, role: 'developer', joinedAt: new Date() }
          ],
          createdAt: new Date(),
          isTestData: true
        },
        {
          name: 'DataTech Solutions',
          description: 'Data science and machine learning consultancy',
          website: 'https://datatechsolutions.com',
          industry: 'Consulting',
          size: '11-50',
          ownerId: users[1]._id,
          members: [
            { userId: users[1]._id, role: 'owner', joinedAt: new Date() },
            { userId: users[3]._id, role: 'developer', joinedAt: new Date() }
          ],
          createdAt: new Date(),
          isTestData: true
        },
        {
          name: 'ML Startup Inc',
          description: 'Innovative machine learning startup',
          website: 'https://mlstartup.io',
          industry: 'Startup',
          size: '1-10',
          ownerId: users[2]._id,
          members: [
            { userId: users[2]._id, role: 'owner', joinedAt: new Date() }
          ],
          createdAt: new Date(),
          isTestData: true
        },
        // Additional test organizations
        ...Array.from({ length: 20 }, (_, i) => ({
          name: `Test Organization ${i + 1}`,
          description: `Test organization ${i + 1} for testing purposes`,
          website: `https://testorg${i + 1}.com`,
          industry: ['Technology', 'Consulting', 'Research', 'Startup'][i % 4],
          size: ['1-10', '11-50', '51-200', '201-500'][i % 4],
          ownerId: users[i % users.length]._id,
          members: [
            { userId: users[i % users.length]._id, role: 'owner', joinedAt: new Date() }
          ],
          createdAt: new Date(Date.now() - Math.random() * 60 * 24 * 60 * 60 * 1000), // Random date within last 60 days
          isTestData: true
        }))
      ];

      const result = await orgsCollection.insertMany(organizations);
      this.seededData.organizations = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${organizations.length} organizations`);
    } catch (error) {
      spinner.fail('Organization seeding failed');
      throw error;
    }
  }

  async seedProducts() {
    const spinner = ora('Seeding products...').start();

    try {
      const db = this.mongoClient.db();
      const productsCollection = db.collection('products');
      const orgsCollection = db.collection('organizations');

      const organizations = await orgsCollection.find({ isTestData: true }).toArray();

      const productTemplates = [
        {
          name: 'Image Classification API',
          description: 'Advanced image classification using deep learning models',
          category: 'Computer Vision',
          subcategory: 'Image Recognition',
          tags: ['ai', 'machine-learning', 'computer-vision', 'classification'],
          pricing: 'Freemium',
          status: 'published'
        },
        {
          name: 'Natural Language Processor',
          description: 'Comprehensive NLP processing with sentiment analysis',
          category: 'Natural Language Processing',
          subcategory: 'Text Analysis',
          tags: ['nlp', 'sentiment-analysis', 'text-processing', 'ai'],
          pricing: 'Premium',
          status: 'published'
        },
        {
          name: 'Recommendation Engine',
          description: 'AI-powered recommendation system for e-commerce',
          category: 'Machine Learning',
          subcategory: 'Recommendation Systems',
          tags: ['recommendations', 'ml', 'e-commerce', 'personalization'],
          pricing: 'Enterprise',
          status: 'published'
        },
        {
          name: 'Speech Recognition API',
          description: 'Real-time speech-to-text conversion service',
          category: 'Speech Processing',
          subcategory: 'Speech Recognition',
          tags: ['speech', 'audio', 'transcription', 'real-time'],
          pricing: 'Pay-per-use',
          status: 'published'
        },
        {
          name: 'Fraud Detection System',
          description: 'AI-based fraud detection for financial transactions',
          category: 'Security',
          subcategory: 'Fraud Detection',
          tags: ['fraud-detection', 'security', 'finance', 'anomaly-detection'],
          pricing: 'Enterprise',
          status: 'published'
        }
      ];

      const products = [];

      // Create multiple variants of each template
      for (const template of productTemplates) {
        for (let i = 0; i < 10; i++) {
          const org = organizations[Math.floor(Math.random() * organizations.length)];
          
          products.push({
            ...template,
            name: `${template.name} ${i > 0 ? `v${i + 1}` : ''}`,
            organizationId: org._id,
            ownerId: org.ownerId,
            version: `1.${i}.0`,
            endpoints: this.generateAPIEndpoints(template.category),
            plans: this.generatePricingPlans(template.pricing),
            metrics: {
              views: Math.floor(Math.random() * 10000),
              downloads: Math.floor(Math.random() * 1000),
              rating: (Math.random() * 2 + 3).toFixed(1), // 3.0 - 5.0
              reviewCount: Math.floor(Math.random() * 100)
            },
            createdAt: new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000), // Random date within last 90 days
            updatedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000), // Random update within last 30 days
            isTestData: true
          });
        }
      }

      const result = await productsCollection.insertMany(products);
      this.seededData.products = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${products.length} products`);
    } catch (error) {
      spinner.fail('Product seeding failed');
      throw error;
    }
  }

  async seedAPIKeys() {
    const spinner = ora('Seeding API keys...').start();

    try {
      const db = this.mongoClient.db();
      const apiKeysCollection = db.collection('apikeys');
      const usersCollection = db.collection('users');

      const users = await usersCollection.find({ isTestData: true }).limit(20).toArray();

      const apiKeys = [];

      for (const user of users) {
        // Each user gets 1-3 API keys
        const keyCount = Math.floor(Math.random() * 3) + 1;
        
        for (let i = 0; i < keyCount; i++) {
          apiKeys.push({
            name: `API Key ${i + 1}`,
            key: this.generateAPIKey(),
            userId: user._id,
            permissions: this.getRandomPermissions(),
            rateLimit: {
              requests: Math.floor(Math.random() * 10000) + 1000,
              period: 'hour'
            },
            expiresAt: new Date(Date.now() + Math.random() * 365 * 24 * 60 * 60 * 1000), // Expires within a year
            createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
            lastUsed: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
            isActive: Math.random() > 0.1, // 90% active
            isTestData: true
          });
        }
      }

      const result = await apiKeysCollection.insertMany(apiKeys);
      this.seededData.apiKeys = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${apiKeys.length} API keys`);
    } catch (error) {
      spinner.fail('API key seeding failed');
      throw error;
    }
  }

  async seedFiles() {
    const spinner = ora('Seeding file records...').start();

    try {
      const db = this.mongoClient.db();
      const filesCollection = db.collection('files');
      const usersCollection = db.collection('users');

      const users = await usersCollection.find({ isTestData: true }).limit(10).toArray();

      const fileTypes = [
        { extension: 'jpg', mimeType: 'image/jpeg', category: 'image' },
        { extension: 'png', mimeType: 'image/png', category: 'image' },
        { extension: 'pdf', mimeType: 'application/pdf', category: 'document' },
        { extension: 'csv', mimeType: 'text/csv', category: 'data' },
        { extension: 'json', mimeType: 'application/json', category: 'data' },
        { extension: 'zip', mimeType: 'application/zip', category: 'archive' }
      ];

      const files = [];

      for (const user of users) {
        const fileCount = Math.floor(Math.random() * 20) + 5; // 5-24 files per user
        
        for (let i = 0; i < fileCount; i++) {
          const fileType = fileTypes[Math.floor(Math.random() * fileTypes.length)];
          const fileName = `test-file-${i + 1}.${fileType.extension}`;
          
          files.push({
            fileName,
            originalName: fileName,
            url: `https://blob.vercel-storage.com/${user._id}/${fileName}`,
            mimeType: fileType.mimeType,
            size: Math.floor(Math.random() * 10000000) + 1000, // 1KB - 10MB
            category: fileType.category,
            userId: user._id,
            metadata: {
              uploadedAt: new Date(Date.now() - Math.random() * 60 * 24 * 60 * 60 * 1000),
              lastAccessed: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
              downloadCount: Math.floor(Math.random() * 100),
              isPublic: Math.random() > 0.7 // 30% public
            },
            tags: this.generateFileTags(fileType.category),
            checksum: this.generateChecksum(),
            isTestData: true
          });
        }
      }

      const result = await filesCollection.insertMany(files);
      this.seededData.files = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${files.length} file records`);
    } catch (error) {
      spinner.fail('File seeding failed');
      throw error;
    }
  }

  async seedAnalyticsData() {
    const spinner = ora('Seeding analytics data...').start();

    try {
      // Seed API request logs in PostgreSQL
      const requestLogs = [];
      const endpoints = [
        '/api/products',
        '/api/users',
        '/api/organizations',
        '/api/files',
        '/api/hub/proxy',
        '/auth/login',
        '/auth/register'
      ];

      const methods = ['GET', 'POST', 'PUT', 'DELETE'];
      const statusCodes = [200, 201, 400, 401, 403, 404, 500];
      const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'PostmanRuntime/7.32.3',
        'Artillery Load Test'
      ];

      // Generate 10,000 request logs over the last 30 days
      for (let i = 0; i < 10000; i++) {
        const timestamp = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);
        
        requestLogs.push([
          endpoints[Math.floor(Math.random() * endpoints.length)],
          methods[Math.floor(Math.random() * methods.length)],
          statusCodes[Math.floor(Math.random() * statusCodes.length)],
          Math.floor(Math.random() * 2000) + 50, // Response time 50-2050ms
          `192.168.1.${Math.floor(Math.random() * 255)}`,
          userAgents[Math.floor(Math.random() * userAgents.length)],
          timestamp
        ]);
      }

      // Insert in batches
      const batchSize = 1000;
      for (let i = 0; i < requestLogs.length; i += batchSize) {
        const batch = requestLogs.slice(i, i + batchSize);
        const values = batch.map(log => 
          `('${log[0]}', '${log[1]}', ${log[2]}, ${log[3]}, '${log[4]}', '${log[5]}', '${log[6].toISOString()}')`
        ).join(',');

        await this.pgPool.query(`
          INSERT INTO api_requests (endpoint, method, status_code, response_time, ip_address, user_agent, timestamp)
          VALUES ${values}
        `);
      }

      // Seed API statistics
      const apiStats = [];
      for (const endpoint of endpoints) {
        const logs = requestLogs.filter(log => log[0] === endpoint);
        const totalRequests = logs.length;
        const successfulRequests = logs.filter(log => log[2] < 400).length;
        const avgResponseTime = logs.reduce((sum, log) => sum + log[3], 0) / logs.length;

        apiStats.push([
          endpoint,
          totalRequests,
          avgResponseTime,
          successfulRequests / totalRequests,
          new Date()
        ]);
      }

      for (const stat of apiStats) {
        await this.pgPool.query(`
          INSERT INTO api_statistics (api_name, total_requests, avg_response_time, success_rate, last_updated)
          VALUES ($1, $2, $3, $4, $5)
        `, stat);
      }

      spinner.succeed(`Seeded ${requestLogs.length} analytics records`);
    } catch (error) {
      spinner.fail('Analytics seeding failed');
      throw error;
    }
  }

  async seedContests() {
    const spinner = ora('Seeding contests...').start();

    try {
      const db = this.mongoClient.db();
      const contestsCollection = db.collection('contests');
      const orgsCollection = db.collection('organizations');

      const organizations = await orgsCollection.find({ isTestData: true }).limit(5).toArray();

      const contests = [
        {
          title: 'AI Image Classification Challenge',
          description: 'Build the most accurate image classification model',
          category: 'Computer Vision',
          organizationId: organizations[0]._id,
          startDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Starts in 7 days
          endDate: new Date(Date.now() + 37 * 24 * 60 * 60 * 1000), // Ends in 37 days
          status: 'upcoming',
          prizes: [
            { position: 1, amount: 10000, currency: 'USD' },
            { position: 2, amount: 5000, currency: 'USD' },
            { position: 3, amount: 2500, currency: 'USD' }
          ],
          rules: 'Standard ML competition rules apply',
          submissionFormat: 'CSV file with predictions',
          evaluationMetric: 'Accuracy',
          maxTeamSize: 5,
          participantCount: 0,
          createdAt: new Date(),
          isTestData: true
        },
        {
          title: 'NLP Sentiment Analysis Contest',
          description: 'Develop the best sentiment analysis model for social media',
          category: 'Natural Language Processing',
          organizationId: organizations[1]._id,
          startDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // Started 10 days ago
          endDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000), // Ends in 20 days
          status: 'active',
          prizes: [
            { position: 1, amount: 8000, currency: 'USD' },
            { position: 2, amount: 4000, currency: 'USD' },
            { position: 3, amount: 2000, currency: 'USD' }
          ],
          rules: 'Use provided dataset only',
          submissionFormat: 'JSON file with sentiment scores',
          evaluationMetric: 'F1 Score',
          maxTeamSize: 3,
          participantCount: 45,
          createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
          isTestData: true
        },
        {
          title: 'Fraud Detection Algorithm Challenge',
          description: 'Create an AI system to detect fraudulent transactions',
          category: 'Machine Learning',
          organizationId: organizations[2]._id,
          startDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // Started 60 days ago
          endDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // Ended 5 days ago
          status: 'completed',
          prizes: [
            { position: 1, amount: 15000, currency: 'USD' },
            { position: 2, amount: 7500, currency: 'USD' },
            { position: 3, amount: 3750, currency: 'USD' }
          ],
          rules: 'Real-world dataset with privacy protection',
          submissionFormat: 'Python script with model',
          evaluationMetric: 'AUC-ROC',
          maxTeamSize: 4,
          participantCount: 128,
          winners: [
            { position: 1, teamName: 'AI Detectives', score: 0.987 },
            { position: 2, teamName: 'Fraud Hunters', score: 0.983 },
            { position: 3, teamName: 'ML Masters', score: 0.979 }
          ],
          createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          isTestData: true
        }
      ];

      const result = await contestsCollection.insertMany(contests);
      this.seededData.contests = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${contests.length} contests`);
    } catch (error) {
      spinner.fail('Contest seeding failed');
      throw error;
    }
  }

  async seedRequests() {
    const spinner = ora('Seeding feature requests...').start();

    try {
      const db = this.mongoClient.db();
      const requestsCollection = db.collection('requests');
      const usersCollection = db.collection('users');

      const users = await usersCollection.find({ isTestData: true }).limit(10).toArray();

      const requestTypes = ['feature', 'integration', 'api', 'improvement', 'bug'];
      const priorities = ['low', 'medium', 'high', 'critical'];
      const statuses = ['pending', 'in-review', 'approved', 'rejected', 'completed'];

      const requests = [];

      for (let i = 0; i < 50; i++) {
        const user = users[Math.floor(Math.random() * users.length)];
        
        requests.push({
          title: `Feature Request ${i + 1}`,
          description: `Detailed description for feature request ${i + 1}. This would include specific requirements and use cases.`,
          type: requestTypes[Math.floor(Math.random() * requestTypes.length)],
          priority: priorities[Math.floor(Math.random() * priorities.length)],
          status: statuses[Math.floor(Math.random() * statuses.length)],
          userId: user._id,
          votes: Math.floor(Math.random() * 100),
          tags: ['enhancement', 'user-request', 'community'],
          estimatedHours: Math.floor(Math.random() * 40) + 8,
          targetRelease: `v${Math.floor(Math.random() * 3) + 1}.${Math.floor(Math.random() * 10)}.0`,
          createdAt: new Date(Date.now() - Math.random() * 180 * 24 * 60 * 60 * 1000), // Last 6 months
          updatedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000), // Last 30 days
          isTestData: true
        });
      }

      const result = await requestsCollection.insertMany(requests);
      this.seededData.requests = Object.values(result.insertedIds);

      spinner.succeed(`Seeded ${requests.length} feature requests`);
    } catch (error) {
      spinner.fail('Request seeding failed');
      throw error;
    }
  }

  async cleanupTestData() {
    console.log(chalk.yellow.bold('\n🧹 Starting test data cleanup...\n'));

    try {
      await this.connect();

      const db = this.mongoClient.db();
      
      // Remove all test data from MongoDB collections
      const collections = [
        'users', 'organizations', 'products', 'apikeys', 
        'files', 'contests', 'requests'
      ];

      for (const collectionName of collections) {
        const collection = db.collection(collectionName);
        const result = await collection.deleteMany({ isTestData: true });
        console.log(chalk.gray(`Removed ${result.deletedCount} test records from ${collectionName}`));
      }

      // Remove test data from PostgreSQL
      await this.pgPool.query('DELETE FROM api_requests WHERE ip_address LIKE \'192.168.1.%\'');
      await this.pgPool.query('DELETE FROM api_statistics WHERE api_name LIKE \'/api/%\'');

      console.log(chalk.green.bold('\n✅ Test data cleanup completed!\n'));

    } catch (error) {
      console.error(chalk.red.bold('\n❌ Test data cleanup failed:\n'), error.message);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  // Utility methods
  generateAPIEndpoints(category) {
    const baseEndpoints = [
      { method: 'POST', path: '/predict', description: 'Make predictions' },
      { method: 'GET', path: '/status', description: 'Get model status' },
      { method: 'GET', path: '/metrics', description: 'Get model metrics' }
    ];

    if (category === 'Computer Vision') {
      baseEndpoints.push(
        { method: 'POST', path: '/analyze-image', description: 'Analyze image content' },
        { method: 'POST', path: '/detect-objects', description: 'Detect objects in image' }
      );
    } else if (category === 'Natural Language Processing') {
      baseEndpoints.push(
        { method: 'POST', path: '/sentiment', description: 'Analyze sentiment' },
        { method: 'POST', path: '/entities', description: 'Extract entities' }
      );
    }

    return baseEndpoints;
  }

  generatePricingPlans(pricingType) {
    const plans = [];

    if (pricingType === 'Freemium' || pricingType === 'Premium' || pricingType === 'Enterprise') {
      plans.push({
        name: 'Free',
        price: 0,
        requests: 1000,
        features: ['Basic API access', 'Community support']
      });
    }

    if (pricingType === 'Premium' || pricingType === 'Enterprise') {
      plans.push({
        name: 'Premium',
        price: 29.99,
        requests: 10000,
        features: ['Advanced API access', 'Priority support', 'Custom models']
      });
    }

    if (pricingType === 'Enterprise') {
      plans.push({
        name: 'Enterprise',
        price: 199.99,
        requests: 100000,
        features: ['Full API access', 'Dedicated support', 'Custom integration', 'SLA guarantee']
      });
    }

    if (pricingType === 'Pay-per-use') {
      plans.push({
        name: 'Pay-per-use',
        price: 0.01,
        priceUnit: 'per request',
        features: ['No monthly commitment', 'Pay only for what you use']
      });
    }

    return plans;
  }

  generateAPIKey() {
    return 'ak_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  getRandomPermissions() {
    const allPermissions = ['read', 'write', 'delete', 'admin'];
    const permissionCount = Math.floor(Math.random() * 3) + 1;
    
    return allPermissions
      .sort(() => 0.5 - Math.random())
      .slice(0, permissionCount);
  }

  generateFileTags(category) {
    const tagsByCategory = {
      image: ['photo', 'graphic', 'design', 'visualization'],
      document: ['report', 'manual', 'specification', 'documentation'],
      data: ['dataset', 'export', 'analysis', 'raw-data'],
      archive: ['backup', 'compressed', 'package', 'bundle']
    };

    const baseTags = ['test-data', 'sample'];
    const categoryTags = tagsByCategory[category] || [];
    
    return [...baseTags, ...categoryTags.slice(0, 2)];
  }

  generateChecksum() {
    return Math.random().toString(16).substring(2, 18);
  }

  async saveSeededDataInfo() {
    const fs = require('fs').promises;
    const path = require('path');

    const seededDataInfo = {
      timestamp: new Date().toISOString(),
      data: this.seededData,
      totalRecords: Object.values(this.seededData).reduce((sum, arr) => sum + arr.length, 0)
    };

    const filePath = path.join(__dirname, 'seeded-data-info.json');
    await fs.writeFile(filePath, JSON.stringify(seededDataInfo, null, 2));
    
    console.log(chalk.blue(`📄 Seeded data info saved to: ${filePath}`));
  }
}

// CLI interface
async function main() {
  const action = process.argv[2] || 'seed';
  const seeder = new TestDataSeeder();

  try {
    switch (action) {
      case 'seed':
        await seeder.seedAll();
        break;
      case 'cleanup':
        await seeder.cleanupTestData();
        break;
      case 'reseed':
        await seeder.cleanupTestData();
        await seeder.seedAll();
        break;
      default:
        console.log(chalk.red(`Unknown action: ${action}`));
        console.log(chalk.blue('Available actions: seed, cleanup, reseed'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red.bold('ERROR:'), error.message);
    process.exit(1);
  }
}

// Export for testing
module.exports = { TestDataSeeder };

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red.bold('FATAL ERROR:'), error);
    process.exit(1);
  });
}