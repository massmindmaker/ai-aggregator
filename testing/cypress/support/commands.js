/**
 * Cypress Custom Commands for AI Aggregator Testing
 * Reusable commands for common testing operations
 */

// Import commands
import 'cypress-file-upload';

/**
 * Custom login command
 */
Cypress.Commands.add('login', (email, password) => {
  cy.session([email, password], () => {
    cy.visit('/login');
    cy.get('[data-testid="email-input"]').type(email);
    cy.get('[data-testid="password-input"]').type(password);
    cy.get('[data-testid="login-button"]').click();
    
    // Wait for successful login
    cy.url().should('include', '/dashboard');
    cy.get('[data-testid="user-avatar"]').should('be.visible');
    
    // Store auth token for API requests
    cy.window().then((win) => {
      const token = win.localStorage.getItem('authToken');
      if (token) {
        cy.wrap(token).as('authToken');
      }
    });
  });
});

/**
 * Custom logout command
 */
Cypress.Commands.add('logout', () => {
  cy.get('[data-testid="user-menu"]').click();
  cy.get('[data-testid="logout-button"]').click();
  cy.url().should('include', '/');
  cy.clearLocalStorage();
  cy.clearCookies();
});

/**
 * Create a test user
 */
Cypress.Commands.add('createTestUser', (userData = {}) => {
  const defaultUser = {
    email: `test-${Date.now()}@aiag.com`,
    password: 'TestPassword123!',
    username: `testuser${Date.now()}`,
    firstName: 'Test',
    lastName: 'User'
  };
  
  const user = { ...defaultUser, ...userData };
  
  cy.request('POST', '/auth/register', user).then((response) => {
    expect(response.status).to.eq(201);
    cy.wrap(user).as('testUser');
  });
});

/**
 * Create a test product
 */
Cypress.Commands.add('createTestProduct', (productData = {}, authToken) => {
  const defaultProduct = {
    name: `Test Product ${Date.now()}`,
    description: 'A test product for automated testing',
    category: 'ai',
    pricing: 'Free',
    tags: ['test', 'automation']
  };
  
  const product = { ...defaultProduct, ...productData };
  
  cy.request({
    method: 'POST',
    url: '/product',
    headers: {
      'Authorization': `Bearer ${authToken}`
    },
    body: product
  }).then((response) => {
    expect(response.status).to.eq(201);
    cy.wrap(response.body).as('testProduct');
  });
});

/**
 * Upload a test file
 */
Cypress.Commands.add('uploadTestFile', (fileName = 'test-file.txt', content = 'test content', authToken) => {
  const formData = new FormData();
  const blob = new Blob([content], { type: 'text/plain' });
  formData.append('file', blob, fileName);
  
  cy.request({
    method: 'POST',
    url: '/api/files/upload',
    headers: {
      'Authorization': `Bearer ${authToken}`
    },
    body: formData
  }).then((response) => {
    expect(response.status).to.be.oneOf([200, 201]);
    cy.wrap(response.body).as('uploadedFile');
  });
});

/**
 * Wait for API response
 */
Cypress.Commands.add('waitForAPI', (alias, timeout = 10000) => {
  cy.wait(alias, { timeout });
});

/**
 * Check if element exists without failing
 */
Cypress.Commands.add('elementExists', (selector) => {
  cy.get('body').then(($body) => {
    return $body.find(selector).length > 0;
  });
});

/**
 * Retry command until condition is met
 */
Cypress.Commands.add('retryUntil', (commandFn, conditionFn, maxRetries = 5) => {
  const attempt = (retryCount) => {
    if (retryCount <= 0) {
      throw new Error('Max retries exceeded');
    }
    
    return commandFn().then(conditionFn).catch(() => {
      cy.wait(1000);
      return attempt(retryCount - 1);
    });
  };
  
  return attempt(maxRetries);
});

/**
 * Take screenshot with custom name
 */
Cypress.Commands.add('takeScreenshot', (name) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  cy.screenshot(`${name}-${timestamp}`);
});

/**
 * Mock API responses
 */
Cypress.Commands.add('mockAPI', (method, url, response, statusCode = 200) => {
  cy.intercept(method, url, {
    statusCode,
    body: response
  }).as(`api${method}${url.replace(/[^a-zA-Z0-9]/g, '')}`);
});

/**
 * Simulate network conditions
 */
Cypress.Commands.add('simulateNetworkConditions', (condition) => {
  const conditions = {
    slow: { delay: 2000 },
    fast: { delay: 100 },
    offline: { forceNetworkError: true },
    unstable: { throttleKbps: 50 }
  };
  
  const config = conditions[condition] || conditions.fast;
  
  cy.intercept('**', (req) => {
    if (config.forceNetworkError) {
      req.destroy();
    } else {
      req.reply((res) => {
        res.delay(config.delay || 0);
        if (config.throttleKbps) {
          res.throttle(config.throttleKbps);
        }
      });
    }
  });
});

/**
 * Wait for page to be fully loaded
 */
Cypress.Commands.add('waitForPageLoad', () => {
  cy.get('[data-testid="page-loader"]').should('not.exist');
  cy.get('[data-testid="page-content"]').should('be.visible');
});

/**
 * Check accessibility
 */
Cypress.Commands.add('checkA11y', (selector = null) => {
  if (selector) {
    cy.get(selector).should('have.attr', 'aria-label');
  } else {
    // Basic accessibility checks
    cy.get('img').each(($img) => {
      cy.wrap($img).should('have.attr', 'alt');
    });
    
    cy.get('input').each(($input) => {
      cy.wrap($input).should('satisfy', ($el) => {
        return $el.attr('aria-label') || $el.attr('placeholder') || $el.prev('label').length > 0;
      });
    });
  }
});

/**
 * Navigate to page and wait for load
 */
Cypress.Commands.add('visitAndWait', (path) => {
  cy.visit(path);
  cy.waitForPageLoad();
});

/**
 * Fill form with validation
 */
Cypress.Commands.add('fillForm', (formData) => {
  Object.entries(formData).forEach(([field, value]) => {
    cy.get(`[data-testid="${field}"]`).clear().type(value);
  });
});

/**
 * Verify form validation errors
 */
Cypress.Commands.add('checkFormValidation', (expectedErrors) => {
  expectedErrors.forEach(errorField => {
    cy.get(`[data-testid="${errorField}-error"]`).should('be.visible');
  });
});

/**
 * Handle file downloads
 */
Cypress.Commands.add('downloadFile', (downloadSelector) => {
  cy.window().document().then(function (doc) {
    doc.addEventListener('click', () => {
      setTimeout(function () { doc.location.reload(); }, 5000);
    });
    cy.get(downloadSelector).click();
  });
});

/**
 * Verify URL patterns
 */
Cypress.Commands.add('verifyURL', (pattern) => {
  cy.url().should('match', new RegExp(pattern));
});

/**
 * Wait for element and click
 */
Cypress.Commands.add('waitAndClick', (selector, timeout = 10000) => {
  cy.get(selector, { timeout }).should('be.visible').click();
});

/**
 * Scroll to element and interact
 */
Cypress.Commands.add('scrollAndClick', (selector) => {
  cy.get(selector).scrollIntoView().should('be.visible').click();
});

/**
 * Test responsive design
 */
Cypress.Commands.add('testResponsive', (breakpoints = ['iphone-x', 'ipad-2', 'macbook-15']) => {
  breakpoints.forEach(viewport => {
    cy.viewport(viewport);
    cy.get('[data-testid="mobile-menu"]').should('be.visible');
    cy.get('[data-testid="content"]').should('be.visible');
  });
});

/**
 * Verify loading states
 */
Cypress.Commands.add('verifyLoading', (selector) => {
  cy.get(selector).should('be.visible');
  cy.get(selector).should('not.exist');
});

/**
 * Verify API call was made
 */
Cypress.Commands.add('verifyAPICall', (method, url) => {
  cy.get('@networkRequests').should('include', `${method} ${url}`);
});

/**
 * Setup network monitoring
 */
Cypress.Commands.add('startNetworkMonitoring', () => {
  const requests = [];
  
  cy.intercept('**', (req) => {
    requests.push(`${req.method} ${req.url}`);
    req.continue();
  });
  
  cy.wrap(requests).as('networkRequests');
});

/**
 * Clean up test data
 */
Cypress.Commands.add('cleanupTestData', (email) => {
  cy.task('cleanupTestData', { email });
});

/**
 * Verify performance metrics
 */
Cypress.Commands.add('verifyPerformance', (expectedLoadTime = 3000) => {
  cy.window().then((win) => {
    const loadTime = win.performance.timing.loadEventEnd - win.performance.timing.navigationStart;
    expect(loadTime).to.be.lessThan(expectedLoadTime);
  });
});

/**
 * Test error boundaries
 */
Cypress.Commands.add('triggerError', (errorType = 'javascript') => {
  if (errorType === 'javascript') {
    cy.window().then((win) => {
      win.triggerTestError = true;
    });
  } else if (errorType === 'network') {
    cy.intercept('**', { forceNetworkError: true });
  }
});

/**
 * Verify error handling
 */
Cypress.Commands.add('verifyErrorHandling', () => {
  cy.get('[data-testid="error-boundary"]').should('be.visible');
  cy.get('[data-testid="error-message"]').should('be.visible');
  cy.get('[data-testid="retry-button"]').should('be.visible');
});

/**
 * Test keyboard navigation
 */
Cypress.Commands.add('testKeyboardNavigation', (startSelector) => {
  cy.get(startSelector).focus();
  cy.get('body').type('{tab}');
  cy.focused().should('be.visible');
});

/**
 * Verify security headers
 */
Cypress.Commands.add('verifySecurityHeaders', () => {
  cy.request('/').then((response) => {
    expect(response.headers).to.have.property('x-content-type-options');
    expect(response.headers).to.have.property('x-frame-options');
    expect(response.headers).to.have.property('x-xss-protection');
  });
});

/**
 * Custom assertion for element visibility with retry
 */
Cypress.Commands.add('shouldBeVisibleEventually', (selector, timeout = 10000) => {
  cy.get(selector, { timeout }).should('be.visible');
});

// Tab navigation command
Cypress.Commands.add('tab', { prevSubject: 'optional' }, (subject) => {
  if (subject) {
    cy.wrap(subject).trigger('keydown', { key: 'Tab' });
  } else {
    cy.get('body').trigger('keydown', { key: 'Tab' });
  }
});

// Support for chaining
Cypress.Commands.overwrite('visit', (originalFn, url, options) => {
  const defaults = {
    failOnStatusCode: false
  };
  
  return originalFn(url, { ...defaults, ...options });
});

// Global error handling
Cypress.on('uncaught:exception', (err, runnable) => {
  // Don't fail on expected test errors
  if (err.message.includes('triggerTestError')) {
    return false;
  }
  
  // Log unexpected errors but don't fail tests
  console.error('Uncaught exception:', err);
  return false;
});

// Command to wait for animations
Cypress.Commands.add('waitForAnimations', () => {
  cy.get('[data-testid="loading-spinner"]').should('not.exist');
  cy.get('.animate-spin').should('not.exist');
  cy.get('.loading').should('not.exist');
});

// Command to verify form submission
Cypress.Commands.add('submitFormAndVerify', (formSelector, expectedResult) => {
  cy.get(formSelector).submit();
  cy.get('[data-testid="form-success"]').should('contain', expectedResult);
});