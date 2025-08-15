/**
 * End-to-End User Journey Tests
 * Testing complete user workflows in AI Aggregator
 */

describe('Complete User Journey Tests', () => {
  const testUser = {
    email: `e2etest-${Date.now()}@aiag.com`,
    password: 'TestPassword123!',
    username: `e2euser${Date.now()}`,
    firstName: 'E2E',
    lastName: 'Test'
  };

  beforeEach(() => {
    // Visit the application
    cy.visit('/');
    
    // Clear any existing data
    cy.clearLocalStorage();
    cy.clearCookies();
  });

  describe('User Registration and Authentication Flow', () => {
    it('should complete full registration process', () => {
      // Navigate to registration
      cy.get('[data-testid="register-link"]').click();
      cy.url().should('include', '/register');

      // Fill registration form
      cy.get('[data-testid="email-input"]').type(testUser.email);
      cy.get('[data-testid="password-input"]').type(testUser.password);
      cy.get('[data-testid="confirm-password-input"]').type(testUser.password);
      cy.get('[data-testid="username-input"]').type(testUser.username);
      cy.get('[data-testid="first-name-input"]').type(testUser.firstName);
      cy.get('[data-testid="last-name-input"]').type(testUser.lastName);

      // Accept terms
      cy.get('[data-testid="terms-checkbox"]').check();

      // Submit registration
      cy.get('[data-testid="register-button"]').click();

      // Should show success message
      cy.get('[data-testid="success-message"]').should('be.visible');
      cy.get('[data-testid="success-message"]').should('contain', 'Registration successful');

      // Should redirect to login or verification page
      cy.url().should('match', /(login|verify)/);
    });

    it('should verify email and complete account activation', () => {
      // This would typically involve checking email and clicking verification link
      // For testing, we might use a test endpoint or mock
      cy.visit('/auth/verify/test-verification-token');
      
      // Should show verification success
      cy.get('[data-testid="verification-success"]').should('be.visible');
      cy.get('[data-testid="continue-button"]').click();
      
      // Should redirect to login
      cy.url().should('include', '/login');
    });

    it('should login with verified account', () => {
      cy.visit('/login');

      // Fill login form
      cy.get('[data-testid="email-input"]').type(testUser.email);
      cy.get('[data-testid="password-input"]').type(testUser.password);

      // Submit login
      cy.get('[data-testid="login-button"]').click();

      // Should redirect to dashboard
      cy.url().should('include', '/dashboard');
      
      // Should show user info
      cy.get('[data-testid="user-avatar"]').should('be.visible');
      cy.get('[data-testid="welcome-message"]').should('contain', testUser.firstName);
    });
  });

  describe('Product Creation and Management Workflow', () => {
    beforeEach(() => {
      // Login before each test
      cy.login(testUser.email, testUser.password);
    });

    it('should create a new AI product', () => {
      // Navigate to product creation
      cy.get('[data-testid="create-product-button"]').click();
      cy.url().should('include', '/products/new');

      // Fill product details
      const productName = `E2E Test Product ${Date.now()}`;
      cy.get('[data-testid="product-name"]').type(productName);
      cy.get('[data-testid="product-description"]').type('This is a test product created during E2E testing');
      cy.get('[data-testid="product-category"]').select('machine-learning');
      cy.get('[data-testid="product-pricing"]').select('Free');

      // Add tags
      cy.get('[data-testid="tags-input"]').type('ai{enter}testing{enter}e2e{enter}');

      // Upload logo
      cy.get('[data-testid="logo-upload"]').selectFile('cypress/fixtures/test-logo.png');
      cy.get('[data-testid="logo-preview"]').should('be.visible');

      // Add API endpoints
      cy.get('[data-testid="add-endpoint-button"]').click();
      cy.get('[data-testid="endpoint-method"]').select('POST');
      cy.get('[data-testid="endpoint-path"]').type('/api/predict');
      cy.get('[data-testid="endpoint-description"]').type('Make predictions using the AI model');

      // Add parameters
      cy.get('[data-testid="add-parameter-button"]').click();
      cy.get('[data-testid="parameter-name"]').type('input_data');
      cy.get('[data-testid="parameter-type"]').select('string');
      cy.get('[data-testid="parameter-required"]').check();
      cy.get('[data-testid="parameter-description"]').type('Input data for prediction');

      // Save product
      cy.get('[data-testid="save-product-button"]').click();

      // Should show success message
      cy.get('[data-testid="success-message"]').should('be.visible');
      cy.get('[data-testid="success-message"]').should('contain', 'Product created successfully');

      // Should redirect to product page
      cy.url().should('include', '/products/');
      cy.get('[data-testid="product-title"]').should('contain', productName);
    });

    it('should edit product details', () => {
      // Navigate to products list
      cy.visit('/products');
      
      // Find the created product
      cy.get('[data-testid="product-card"]').first().click();
      
      // Edit product
      cy.get('[data-testid="edit-product-button"]').click();
      
      // Update description
      cy.get('[data-testid="product-description"]').clear();
      cy.get('[data-testid="product-description"]').type('Updated description for E2E testing');
      
      // Add another endpoint
      cy.get('[data-testid="add-endpoint-button"]').click();
      cy.get('[data-testid="endpoint-method"]').last().select('GET');
      cy.get('[data-testid="endpoint-path"]').last().type('/api/status');
      cy.get('[data-testid="endpoint-description"]').last().type('Check model status');
      
      // Save changes
      cy.get('[data-testid="save-changes-button"]').click();
      
      // Should show success message
      cy.get('[data-testid="success-message"]').should('be.visible');
      
      // Should reflect changes
      cy.get('[data-testid="product-description"]').should('contain', 'Updated description');
    });

    it('should publish product to marketplace', () => {
      // Navigate to product
      cy.visit('/products');
      cy.get('[data-testid="product-card"]').first().click();
      
      // Publish product
      cy.get('[data-testid="publish-button"]').click();
      
      // Confirm publication
      cy.get('[data-testid="confirm-publish"]').should('be.visible');
      cy.get('[data-testid="publish-agreement"]').check();
      cy.get('[data-testid="confirm-publish-button"]').click();
      
      // Should show success
      cy.get('[data-testid="publish-success"]').should('be.visible');
      
      // Product should show as published
      cy.get('[data-testid="product-status"]').should('contain', 'Published');
      cy.get('[data-testid="marketplace-link"]').should('be.visible');
    });
  });

  describe('File Upload and Management Workflow', () => {
    beforeEach(() => {
      cy.login(testUser.email, testUser.password);
    });

    it('should upload and manage files', () => {
      // Navigate to files section
      cy.get('[data-testid="files-menu"]').click();
      cy.url().should('include', '/files');

      // Upload image file
      cy.get('[data-testid="upload-button"]').click();
      cy.get('[data-testid="file-input"]').selectFile('cypress/fixtures/test-image.jpg');
      
      // Should show upload progress
      cy.get('[data-testid="upload-progress"]').should('be.visible');
      
      // Should show success
      cy.get('[data-testid="upload-success"]').should('be.visible', { timeout: 10000 });
      
      // File should appear in list
      cy.get('[data-testid="file-list"]').should('contain', 'test-image.jpg');

      // Upload document
      cy.get('[data-testid="upload-button"]').click();
      cy.get('[data-testid="file-input"]').selectFile('cypress/fixtures/test-document.pdf');
      cy.get('[data-testid="upload-success"]').should('be.visible', { timeout: 10000 });

      // Test file operations
      cy.get('[data-testid="file-item"]').first().within(() => {
        // View file details
        cy.get('[data-testid="file-details-button"]').click();
      });

      cy.get('[data-testid="file-details-modal"]').should('be.visible');
      cy.get('[data-testid="file-size"]').should('be.visible');
      cy.get('[data-testid="file-type"]').should('be.visible');
      cy.get('[data-testid="upload-date"]').should('be.visible');

      // Close modal
      cy.get('[data-testid="close-modal"]').click();

      // Test file sharing
      cy.get('[data-testid="file-item"]').first().within(() => {
        cy.get('[data-testid="share-button"]').click();
      });

      cy.get('[data-testid="share-modal"]').should('be.visible');
      cy.get('[data-testid="generate-link-button"]').click();
      cy.get('[data-testid="share-link"]').should('be.visible');
      cy.get('[data-testid="copy-link-button"]').click();

      // Should show copied confirmation
      cy.get('[data-testid="copy-success"]').should('be.visible');
    });

    it('should handle file upload errors gracefully', () => {
      cy.visit('/files');

      // Try to upload oversized file
      cy.get('[data-testid="upload-button"]').click();
      cy.get('[data-testid="file-input"]').selectFile('cypress/fixtures/large-file.zip');

      // Should show error
      cy.get('[data-testid="upload-error"]').should('be.visible');
      cy.get('[data-testid="error-message"]').should('contain', 'file size');

      // Try to upload unsupported file type
      cy.get('[data-testid="upload-button"]').click();
      cy.get('[data-testid="file-input"]').selectFile('cypress/fixtures/malicious.exe');

      // Should show error
      cy.get('[data-testid="upload-error"]').should('be.visible');
      cy.get('[data-testid="error-message"]').should('contain', 'file type');
    });
  });

  describe('API Hub Usage Workflow', () => {
    beforeEach(() => {
      cy.login(testUser.email, testUser.password);
    });

    it('should create and use API keys', () => {
      // Navigate to API Hub
      cy.get('[data-testid="api-hub-menu"]').click();
      cy.url().should('include', '/api-hub');

      // Create new API key
      cy.get('[data-testid="create-api-key-button"]').click();
      cy.get('[data-testid="api-key-name"]').type('E2E Test Key');
      cy.get('[data-testid="api-key-permissions"]').select(['read', 'write']);
      cy.get('[data-testid="create-key-button"]').click();

      // Should show API key
      cy.get('[data-testid="api-key-display"]').should('be.visible');
      cy.get('[data-testid="copy-key-button"]').click();

      // Should show in keys list
      cy.get('[data-testid="api-keys-list"]').should('contain', 'E2E Test Key');
    });

    it('should test API endpoints through proxy', () => {
      // Go to API testing interface
      cy.visit('/api-hub/test');

      // Select endpoint to test
      cy.get('[data-testid="endpoint-selector"]').select('/api/products');
      cy.get('[data-testid="method-selector"]').select('GET');

      // Add headers
      cy.get('[data-testid="add-header-button"]').click();
      cy.get('[data-testid="header-name"]').type('Authorization');
      cy.get('[data-testid="header-value"]').type('Bearer test-token');

      // Add query parameters
      cy.get('[data-testid="add-param-button"]').click();
      cy.get('[data-testid="param-name"]').type('limit');
      cy.get('[data-testid="param-value"]').type('10');

      // Send request
      cy.get('[data-testid="send-request-button"]').click();

      // Should show response
      cy.get('[data-testid="response-section"]').should('be.visible');
      cy.get('[data-testid="response-status"]').should('be.visible');
      cy.get('[data-testid="response-body"]').should('be.visible');
      cy.get('[data-testid="response-headers"]').should('be.visible');
    });

    it('should view API analytics', () => {
      cy.visit('/api-hub/analytics');

      // Should show analytics dashboard
      cy.get('[data-testid="analytics-dashboard"]').should('be.visible');
      cy.get('[data-testid="total-requests"]').should('be.visible');
      cy.get('[data-testid="success-rate"]').should('be.visible');
      cy.get('[data-testid="avg-response-time"]').should('be.visible');

      // Test date range filter
      cy.get('[data-testid="date-range-selector"]').select('7d');
      cy.get('[data-testid="apply-filter-button"]').click();

      // Should update charts
      cy.get('[data-testid="requests-chart"]').should('be.visible');
      cy.get('[data-testid="performance-chart"]').should('be.visible');
    });
  });

  describe('Marketplace and Discovery Workflow', () => {
    beforeEach(() => {
      cy.login(testUser.email, testUser.password);
    });

    it('should browse and discover products', () => {
      // Navigate to marketplace
      cy.get('[data-testid="marketplace-menu"]').click();
      cy.url().should('include', '/marketplace');

      // Should show featured products
      cy.get('[data-testid="featured-products"]').should('be.visible');
      cy.get('[data-testid="product-grid"]').should('be.visible');

      // Test search functionality
      cy.get('[data-testid="search-input"]').type('machine learning');
      cy.get('[data-testid="search-button"]').click();

      // Should show search results
      cy.get('[data-testid="search-results"]').should('be.visible');
      cy.get('[data-testid="results-count"]').should('be.visible');

      // Test category filter
      cy.get('[data-testid="category-filter"]').select('ai');
      cy.get('[data-testid="apply-filters-button"]').click();

      // Should filter results
      cy.get('[data-testid="filtered-results"]').should('be.visible');

      // Test sorting
      cy.get('[data-testid="sort-selector"]').select('popular');
      cy.get('[data-testid="product-grid"]').should('be.visible');
    });

    it('should view product details and documentation', () => {
      cy.visit('/marketplace');

      // Click on a product
      cy.get('[data-testid="product-card"]').first().click();

      // Should show product details
      cy.get('[data-testid="product-details"]').should('be.visible');
      cy.get('[data-testid="product-description"]').should('be.visible');
      cy.get('[data-testid="product-pricing"]').should('be.visible');
      cy.get('[data-testid="product-tags"]').should('be.visible');

      // Test API documentation
      cy.get('[data-testid="api-docs-tab"]').click();
      cy.get('[data-testid="api-endpoints"]').should('be.visible');
      cy.get('[data-testid="endpoint-details"]').should('be.visible');

      // Test code examples
      cy.get('[data-testid="code-examples-tab"]').click();
      cy.get('[data-testid="code-snippets"]').should('be.visible');
      cy.get('[data-testid="language-selector"]').select('javascript');
      cy.get('[data-testid="code-example"]').should('be.visible');

      // Test copy code functionality
      cy.get('[data-testid="copy-code-button"]').click();
      cy.get('[data-testid="copy-success"]').should('be.visible');
    });

    it('should subscribe to product and manage subscriptions', () => {
      cy.visit('/marketplace');
      cy.get('[data-testid="product-card"]').first().click();

      // Subscribe to product
      cy.get('[data-testid="subscribe-button"]').click();

      // Should show subscription options
      cy.get('[data-testid="subscription-modal"]').should('be.visible');
      cy.get('[data-testid="plan-selector"]').select('Basic');
      cy.get('[data-testid="confirm-subscription"]').click();

      // Should show success
      cy.get('[data-testid="subscription-success"]').should('be.visible');

      // Navigate to subscriptions
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="subscriptions-link"]').click();

      // Should show active subscriptions
      cy.get('[data-testid="active-subscriptions"]').should('be.visible');
      cy.get('[data-testid="subscription-item"]').should('be.visible');

      // Test subscription management
      cy.get('[data-testid="manage-subscription"]').first().click();
      cy.get('[data-testid="subscription-details"]').should('be.visible');
      cy.get('[data-testid="usage-stats"]').should('be.visible');
    });
  });

  describe('User Profile and Settings Workflow', () => {
    beforeEach(() => {
      cy.login(testUser.email, testUser.password);
    });

    it('should update user profile', () => {
      // Navigate to profile
      cy.get('[data-testid="user-menu"]').click();
      cy.get('[data-testid="profile-link"]').click();

      // Update profile information
      cy.get('[data-testid="edit-profile-button"]').click();
      cy.get('[data-testid="bio-input"]').type('E2E Test User Bio');
      cy.get('[data-testid="location-input"]').type('Test City');
      cy.get('[data-testid="website-input"]').type('https://test-website.com');

      // Upload avatar
      cy.get('[data-testid="avatar-upload"]').selectFile('cypress/fixtures/avatar.jpg');
      cy.get('[data-testid="avatar-preview"]').should('be.visible');

      // Save changes
      cy.get('[data-testid="save-profile-button"]').click();

      // Should show success
      cy.get('[data-testid="profile-updated"]').should('be.visible');

      // Should reflect changes
      cy.get('[data-testid="user-bio"]').should('contain', 'E2E Test User Bio');
      cy.get('[data-testid="user-location"]').should('contain', 'Test City');
    });

    it('should manage account settings', () => {
      cy.visit('/settings');

      // Test notification settings
      cy.get('[data-testid="notifications-tab"]').click();
      cy.get('[data-testid="email-notifications"]').uncheck();
      cy.get('[data-testid="push-notifications"]').check();
      cy.get('[data-testid="save-notifications"]').click();

      // Should show success
      cy.get('[data-testid="settings-saved"]').should('be.visible');

      // Test privacy settings
      cy.get('[data-testid="privacy-tab"]').click();
      cy.get('[data-testid="profile-visibility"]').select('public');
      cy.get('[data-testid="data-sharing"]').uncheck();
      cy.get('[data-testid="save-privacy"]').click();

      // Should show success
      cy.get('[data-testid="settings-saved"]').should('be.visible');
    });

    it('should change password', () => {
      cy.visit('/settings');
      cy.get('[data-testid="security-tab"]').click();

      // Change password
      cy.get('[data-testid="change-password-button"]').click();
      cy.get('[data-testid="current-password"]').type(testUser.password);
      cy.get('[data-testid="new-password"]').type('NewPassword123!');
      cy.get('[data-testid="confirm-new-password"]').type('NewPassword123!');
      cy.get('[data-testid="update-password-button"]').click();

      // Should show success
      cy.get('[data-testid="password-updated"]').should('be.visible');

      // Should require re-login
      cy.get('[data-testid="re-login-required"]').should('be.visible');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle network errors gracefully', () => {
      cy.login(testUser.email, testUser.password);

      // Simulate network failure
      cy.intercept('GET', '/api/products', { forceNetworkError: true });
      
      cy.visit('/products');

      // Should show error message
      cy.get('[data-testid="network-error"]').should('be.visible');
      cy.get('[data-testid="retry-button"]').should('be.visible');

      // Test retry functionality
      cy.intercept('GET', '/api/products', { fixture: 'products.json' });
      cy.get('[data-testid="retry-button"]').click();

      // Should recover and show products
      cy.get('[data-testid="product-list"]').should('be.visible');
    });

    it('should handle session expiration', () => {
      cy.login(testUser.email, testUser.password);

      // Simulate expired token
      cy.intercept('GET', '/api/user/profile', { statusCode: 401 });
      
      cy.visit('/profile');

      // Should redirect to login
      cy.url().should('include', '/login');
      cy.get('[data-testid="session-expired-message"]').should('be.visible');
    });

    it('should validate form inputs', () => {
      cy.visit('/products/new');

      // Try to submit empty form
      cy.get('[data-testid="save-product-button"]').click();

      // Should show validation errors
      cy.get('[data-testid="name-error"]').should('be.visible');
      cy.get('[data-testid="description-error"]').should('be.visible');

      // Fill invalid data
      cy.get('[data-testid="product-name"]').type('a'); // Too short
      cy.get('[data-testid="product-description"]').type('short'); // Too short

      cy.get('[data-testid="save-product-button"]').click();

      // Should show specific validation errors
      cy.get('[data-testid="name-length-error"]').should('be.visible');
      cy.get('[data-testid="description-length-error"]').should('be.visible');
    });
  });

  describe('Responsive Design and Accessibility', () => {
    it('should work on mobile devices', () => {
      cy.viewport('iphone-x');
      cy.login(testUser.email, testUser.password);

      // Test mobile navigation
      cy.get('[data-testid="mobile-menu-button"]').click();
      cy.get('[data-testid="mobile-menu"]').should('be.visible');
      cy.get('[data-testid="products-mobile-link"]').click();

      // Should navigate correctly
      cy.url().should('include', '/products');

      // Test responsive layout
      cy.get('[data-testid="product-grid"]').should('be.visible');
      cy.get('[data-testid="product-card"]').should('have.class', 'mobile-layout');
    });

    it('should be accessible with keyboard navigation', () => {
      cy.visit('/');

      // Test keyboard navigation
      cy.get('body').tab();
      cy.focused().should('have.attr', 'data-testid', 'skip-to-content');
      
      cy.tab();
      cy.focused().should('have.attr', 'data-testid', 'main-logo');
      
      cy.tab();
      cy.focused().should('have.attr', 'data-testid', 'products-link');

      // Test form accessibility
      cy.visit('/login');
      cy.get('[data-testid="email-input"]').should('have.attr', 'aria-label');
      cy.get('[data-testid="password-input"]').should('have.attr', 'aria-label');
      cy.get('[data-testid="login-button"]').should('have.attr', 'aria-describedby');
    });

    it('should support screen readers', () => {
      cy.visit('/marketplace');

      // Check for proper ARIA labels
      cy.get('[data-testid="search-input"]').should('have.attr', 'aria-label', 'Search products');
      cy.get('[data-testid="product-grid"]').should('have.attr', 'role', 'grid');
      cy.get('[data-testid="product-card"]').should('have.attr', 'role', 'gridcell');

      // Check for proper heading structure
      cy.get('h1').should('exist');
      cy.get('h2').should('exist');

      // Check for alt text on images
      cy.get('img').each(($img) => {
        cy.wrap($img).should('have.attr', 'alt');
      });
    });
  });

  after(() => {
    // Cleanup - delete test user and data
    cy.task('cleanupTestData', { email: testUser.email });
  });
});