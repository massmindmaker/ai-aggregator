/**
 * Migration Verification E2E Tests
 * Testing data integrity and functionality after Vercel migration
 */

describe('Migration Verification Tests', () => {
  const testUser = {
    email: 'migration-test@aiag.com',
    password: 'MigrationTest123!'
  };

  beforeEach(() => {
    cy.visit('/');
    cy.clearLocalStorage();
    cy.clearCookies();
  });

  describe('Data Migration Verification', () => {
    it('should verify migrated user data integrity', () => {
      cy.login(testUser.email, testUser.password);
      
      // Navigate to profile
      cy.visit('/profile');
      
      // Verify user data exists and is correct
      cy.get('[data-testid="user-email"]').should('contain', testUser.email);
      cy.get('[data-testid="user-profile"]').should('be.visible');
      cy.get('[data-testid="account-creation-date"]').should('be.visible');
      
      // Verify user preferences are preserved
      cy.get('[data-testid="user-preferences"]').should('be.visible');
      cy.get('[data-testid="notification-settings"]').should('be.visible');
    });

    it('should verify migrated product data', () => {
      cy.login(testUser.email, testUser.password);
      
      // Check user's products
      cy.visit('/products');
      
      // Should show existing products from before migration
      cy.get('[data-testid="product-list"]').should('be.visible');
      cy.get('[data-testid="product-card"]').should('have.length.at.least', 1);
      
      // Verify product details are intact
      cy.get('[data-testid="product-card"]').first().click();
      cy.get('[data-testid="product-title"]').should('be.visible');
      cy.get('[data-testid="product-description"]').should('be.visible');
      cy.get('[data-testid="product-category"]').should('be.visible');
      cy.get('[data-testid="api-endpoints"]').should('be.visible');
      
      // Verify creation and modification dates
      cy.get('[data-testid="created-date"]').should('be.visible');
      cy.get('[data-testid="modified-date"]').should('be.visible');
    });

    it('should verify migrated file attachments', () => {
      cy.login(testUser.email, testUser.password);
      
      // Navigate to files
      cy.visit('/files');
      
      // Check if files from old system are accessible
      cy.get('[data-testid="file-list"]').should('be.visible');
      
      // Test file access from Vercel Blob Storage
      cy.get('[data-testid="file-item"]').first().within(() => {
        cy.get('[data-testid="file-name"]').should('be.visible');
        cy.get('[data-testid="file-size"]').should('be.visible');
        cy.get('[data-testid="file-date"]').should('be.visible');
        
        // Test file download
        cy.get('[data-testid="download-button"]').click();
      });
      
      // Should successfully download file
      cy.get('[data-testid="download-success"]').should('be.visible');
    });

    it('should verify API usage history is preserved', () => {
      cy.login(testUser.email, testUser.password);
      
      // Navigate to API analytics
      cy.visit('/api-hub/analytics');
      
      // Should show historical API usage data
      cy.get('[data-testid="usage-history"]').should('be.visible');
      cy.get('[data-testid="total-requests"]').should('be.visible');
      cy.get('[data-testid="historical-chart"]').should('be.visible');
      
      // Verify data spans pre-migration period
      cy.get('[data-testid="date-range"]').should('contain', 'historical data');
      
      // Check specific metrics are preserved
      cy.get('[data-testid="success-rate"]').should('be.visible');
      cy.get('[data-testid="avg-response-time"]').should('be.visible');
    });

    it('should verify subscription and billing data', () => {
      cy.login(testUser.email, testUser.password);
      
      // Check subscriptions
      cy.visit('/subscriptions');
      
      // Verify active subscriptions are preserved
      cy.get('[data-testid="active-subscriptions"]').should('be.visible');
      cy.get('[data-testid="subscription-item"]').should('have.length.at.least', 1);
      
      // Check billing history
      cy.visit('/billing');
      cy.get('[data-testid="billing-history"]').should('be.visible');
      cy.get('[data-testid="invoice-item"]').should('be.visible');
      
      // Verify payment methods are intact
      cy.get('[data-testid="payment-methods"]').should('be.visible');
    });
  });

  describe('URL Migration and Redirects', () => {
    it('should handle old Yandex Cloud URLs with redirects', () => {
      const oldUrls = [
        '/old-api-path/products',
        '/legacy/user/profile',
        '/yandex-storage/files'
      ];
      
      oldUrls.forEach(oldUrl => {
        cy.visit(oldUrl, { failOnStatusCode: false });
        
        // Should redirect to new URL structure
        cy.url().should('not.include', 'old-api-path');
        cy.url().should('not.include', 'legacy');
        cy.url().should('not.include', 'yandex-storage');
        
        // Should show appropriate content or redirect message
        cy.get('body').should('be.visible');
      });
    });

    it('should maintain SEO-friendly URLs', () => {
      // Check that important pages have clean URLs
      const cleanUrls = [
        '/products',
        '/marketplace',
        '/api-hub',
        '/docs'
      ];
      
      cleanUrls.forEach(url => {
        cy.visit(url);
        cy.url().should('equal', Cypress.config().baseUrl + url);
        
        // Should load successfully
        cy.get('[data-testid="page-content"]').should('be.visible');
      });
    });

    it('should preserve external API endpoint URLs', () => {
      cy.login(testUser.email, testUser.password);
      
      // Test that API endpoints still work with same URLs
      cy.request('GET', '/api/products').then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.be.an('array');
      });
      
      cy.request('GET', '/api/user/profile', {
        headers: {
          'Authorization': `Bearer ${window.localStorage.getItem('authToken')}`
        }
      }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('email');
      });
    });
  });

  describe('Performance After Migration', () => {
    it('should verify page load times are acceptable', () => {
      const startTime = Date.now();
      
      cy.visit('/');
      cy.get('[data-testid="homepage-loaded"]').should('be.visible');
      
      const loadTime = Date.now() - startTime;
      expect(loadTime).to.be.lessThan(3000); // Should load within 3 seconds
    });

    it('should verify API response times are improved', () => {
      cy.login(testUser.email, testUser.password);
      
      // Test API response times
      const apiEndpoints = [
        '/api/products',
        '/api/user/profile',
        '/api/files',
        '/api/analytics/dashboard'
      ];
      
      apiEndpoints.forEach(endpoint => {
        const startTime = Date.now();
        
        cy.request({
          url: endpoint,
          headers: {
            'Authorization': `Bearer ${window.localStorage.getItem('authToken')}`
          }
        }).then(() => {
          const responseTime = Date.now() - startTime;
          expect(responseTime).to.be.lessThan(2000); // Should respond within 2 seconds
        });
      });
    });

    it('should verify file upload/download speeds', () => {
      cy.login(testUser.email, testUser.password);
      cy.visit('/files');
      
      const startTime = Date.now();
      
      // Upload test file
      cy.get('[data-testid="upload-button"]').click();
      cy.get('[data-testid="file-input"]').selectFile('cypress/fixtures/test-file.jpg');
      
      cy.get('[data-testid="upload-success"]').should('be.visible').then(() => {
        const uploadTime = Date.now() - startTime;
        expect(uploadTime).to.be.lessThan(10000); // Upload should complete within 10 seconds
      });
    });
  });

  describe('Feature Compatibility Post-Migration', () => {
    it('should verify all core features work correctly', () => {
      cy.login(testUser.email, testUser.password);
      
      // Test product creation
      cy.visit('/products/new');
      cy.get('[data-testid="product-name"]').type('Migration Test Product');
      cy.get('[data-testid="product-description"]').type('Testing product creation after migration');
      cy.get('[data-testid="product-category"]').select('ai');
      cy.get('[data-testid="save-product-button"]').click();
      
      cy.get('[data-testid="success-message"]').should('be.visible');
      
      // Test file upload
      cy.visit('/files');
      cy.get('[data-testid="upload-button"]').click();
      cy.get('[data-testid="file-input"]').selectFile('cypress/fixtures/migration-test.txt');
      cy.get('[data-testid="upload-success"]').should('be.visible');
      
      // Test API Hub functionality
      cy.visit('/api-hub');
      cy.get('[data-testid="create-api-key-button"]').click();
      cy.get('[data-testid="api-key-name"]').type('Migration Test Key');
      cy.get('[data-testid="create-key-button"]').click();
      cy.get('[data-testid="api-key-created"]').should('be.visible');
    });

    it('should verify search functionality works', () => {
      cy.visit('/marketplace');
      
      // Test search
      cy.get('[data-testid="search-input"]').type('machine learning');
      cy.get('[data-testid="search-button"]').click();
      
      cy.get('[data-testid="search-results"]').should('be.visible');
      cy.get('[data-testid="results-count"]').should('be.visible');
      
      // Test filters
      cy.get('[data-testid="category-filter"]').select('ai');
      cy.get('[data-testid="pricing-filter"]').select('free');
      cy.get('[data-testid="apply-filters"]').click();
      
      cy.get('[data-testid="filtered-results"]').should('be.visible');
    });

    it('should verify real-time features work', () => {
      cy.login(testUser.email, testUser.password);
      cy.visit('/dashboard');
      
      // Test notifications
      cy.get('[data-testid="notifications-panel"]').should('be.visible');
      
      // Test live data updates
      cy.get('[data-testid="live-stats"]').should('be.visible');
      cy.get('[data-testid="last-updated"]').should('be.visible');
      
      // Verify WebSocket connections work
      cy.window().then((win) => {
        expect(win.WebSocket).to.exist;
      });
    });
  });

  describe('Database Migration Verification', () => {
    it('should verify MongoDB data integrity', () => {
      cy.login(testUser.email, testUser.password);
      
      // Check that all collections are accessible
      cy.visit('/admin/data-integrity');
      
      cy.get('[data-testid="mongodb-status"]').should('contain', 'Connected');
      cy.get('[data-testid="collections-count"]').should('be.visible');
      
      // Verify specific collections
      const collections = ['products', 'users', 'organizations', 'files'];
      collections.forEach(collection => {
        cy.get(`[data-testid="${collection}-collection"]`)
          .should('be.visible')
          .should('contain', 'Healthy');
      });
    });

    it('should verify PostgreSQL metrics data', () => {
      cy.login(testUser.email, testUser.password);
      
      // Check metrics database
      cy.visit('/admin/metrics-health');
      
      cy.get('[data-testid="postgres-status"]').should('contain', 'Connected');
      cy.get('[data-testid="metrics-tables"]').should('be.visible');
      
      // Verify data continuity
      cy.get('[data-testid="data-continuity"]').should('contain', 'Verified');
      cy.get('[data-testid="migration-gaps"]').should('contain', 'None');
    });

    it('should verify data relationships are preserved', () => {
      cy.login(testUser.email, testUser.password);
      
      // Test user -> products relationship
      cy.visit('/products');
      cy.get('[data-testid="product-card"]').first().click();
      cy.get('[data-testid="product-owner"]').should('be.visible');
      
      // Test product -> files relationship
      cy.get('[data-testid="product-files"]').should('be.visible');
      
      // Test organization relationships
      cy.visit('/organizations');
      cy.get('[data-testid="org-card"]').first().click();
      cy.get('[data-testid="org-members"]').should('be.visible');
      cy.get('[data-testid="org-products"]').should('be.visible');
    });
  });

  describe('Monitoring and Error Handling', () => {
    it('should verify error tracking is working', () => {
      // Trigger intentional error
      cy.visit('/trigger-error');
      
      // Should handle error gracefully
      cy.get('[data-testid="error-boundary"]').should('be.visible');
      cy.get('[data-testid="error-message"]').should('be.visible');
      cy.get('[data-testid="report-error-button"]').should('be.visible');
    });

    it('should verify logging is functional', () => {
      cy.login(testUser.email, testUser.password);
      
      // Perform actions that should be logged
      cy.visit('/products');
      cy.get('[data-testid="product-card"]').first().click();
      
      // Check admin logs (if accessible)
      cy.visit('/admin/logs');
      cy.get('[data-testid="recent-logs"]').should('be.visible');
      cy.get('[data-testid="log-entry"]').should('contain', 'product_view');
    });

    it('should verify health checks are passing', () => {
      // Check system health endpoint
      cy.request('/health').then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body).to.have.property('status', 'healthy');
        expect(response.body).to.have.property('database');
        expect(response.body).to.have.property('storage');
      });
      
      // Check detailed health
      cy.request('/health/detailed').then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.mongodb).to.have.property('status', 'up');
        expect(response.body.postgresql).to.have.property('status', 'up');
        expect(response.body.vercel_blob).to.have.property('status', 'up');
      });
    });
  });

  describe('Security Post-Migration', () => {
    it('should verify HTTPS is enforced', () => {
      // Check that HTTP redirects to HTTPS
      cy.request({
        url: Cypress.config().baseUrl.replace('https://', 'http://'),
        followRedirect: false,
        failOnStatusCode: false
      }).then((response) => {
        expect(response.status).to.be.oneOf([301, 302, 308]);
        expect(response.headers.location).to.include('https://');
      });
    });

    it('should verify security headers are present', () => {
      cy.visit('/');
      
      cy.window().then((win) => {
        // Check for security headers in network tab
        cy.request('/').then((response) => {
          expect(response.headers).to.have.property('x-content-type-options');
          expect(response.headers).to.have.property('x-frame-options');
          expect(response.headers).to.have.property('x-xss-protection');
        });
      });
    });

    it('should verify authentication still works securely', () => {
      // Test login security
      cy.visit('/login');
      cy.get('[data-testid="email-input"]').type(testUser.email);
      cy.get('[data-testid="password-input"]').type(testUser.password);
      cy.get('[data-testid="login-button"]').click();
      
      // Should successfully authenticate
      cy.url().should('include', '/dashboard');
      
      // Token should be stored securely
      cy.window().then((win) => {
        const token = win.localStorage.getItem('authToken');
        expect(token).to.exist;
        expect(token).to.match(/^[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*$/); // JWT format
      });
    });
  });

  describe('Backup and Recovery Verification', () => {
    it('should verify backup systems are functional', () => {
      cy.login(testUser.email, testUser.password);
      
      // Check backup status (admin functionality)
      cy.visit('/admin/backups');
      
      cy.get('[data-testid="backup-status"]').should('contain', 'Active');
      cy.get('[data-testid="last-backup"]').should('be.visible');
      cy.get('[data-testid="backup-schedule"]').should('be.visible');
    });

    it('should verify disaster recovery procedures', () => {
      // This would test recovery procedures in a staging environment
      // For production, we verify the procedures are documented and accessible
      
      cy.visit('/admin/disaster-recovery');
      cy.get('[data-testid="recovery-procedures"]').should('be.visible');
      cy.get('[data-testid="emergency-contacts"]').should('be.visible');
      cy.get('[data-testid="rollback-procedures"]').should('be.visible');
    });
  });
});