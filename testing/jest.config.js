module.exports = {
  // Test environment
  testEnvironment: 'node',
  
  // Root directory
  rootDir: './',
  
  // Test file patterns
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/*.spec.js'
  ],
  
  // Setup files
  setupFilesAfterEnv: [
    '<rootDir>/setup/jest.setup.js'
  ],
  
  // Coverage configuration
  collectCoverage: true,
  collectCoverageFrom: [
    '../aiag_back/**/*.js',
    '../aiaghub/**/*.js',
    '!**/node_modules/**',
    '!**/coverage/**',
    '!**/dist/**',
    '!**/build/**',
    '!**/*.config.js',
    '!**/vercel.json'
  ],
  
  coverageDirectory: './coverage',
  coverageReporters: [
    'text',
    'lcov',
    'html',
    'json'
  ],
  
  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  
  // Test timeout
  testTimeout: 30000,
  
  // Modules and paths
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/../aiag_back/$1',
    '^@hub/(.*)$': '<rootDir>/../aiaghub/$1',
    '^@testing/(.*)$': '<rootDir>/$1'
  },
  
  // Transform configuration
  transform: {
    '^.+\\.jsx?$': 'babel-jest'
  },
  
  // Module file extensions
  moduleFileExtensions: [
    'js',
    'json',
    'jsx',
    'ts',
    'tsx'
  ],
  
  // Test environments for different test types
  projects: [
    {
      displayName: 'unit-tests',
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      testEnvironment: 'node',
      setupFilesAfterEnv: ['<rootDir>/setup/jest.setup.js']
    },
    {
      displayName: 'integration-tests',
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      testEnvironment: 'node',
      setupFilesAfterEnv: ['<rootDir>/setup/jest.setup.js'],
      testTimeout: 60000
    },
    {
      displayName: 'performance-tests',
      testMatch: ['<rootDir>/tests/performance/**/*.test.js'],
      testEnvironment: 'node',
      setupFilesAfterEnv: ['<rootDir>/setup/jest.setup.js'],
      testTimeout: 120000
    },
    {
      displayName: 'security-tests',
      testMatch: ['<rootDir>/tests/security/**/*.test.js'],
      testEnvironment: 'node',
      setupFilesAfterEnv: ['<rootDir>/setup/jest.setup.js'],
      testTimeout: 60000
    }
  ],
  
  // Reporters
  reporters: [
    'default',
    [
      'jest-html-reporters',
      {
        publicPath: './reports',
        filename: 'test-report.html',
        expand: true,
        hideIcon: false
      }
    ],
    [
      'jest-junit',
      {
        outputDirectory: './reports',
        outputName: 'junit.xml',
        suiteName: 'AI Aggregator Tests'
      }
    ]
  ],
  
  // Global variables
  globals: {
    'TEST_CONFIG': {
      LOCAL_URL: 'http://localhost:3000',
      VERCEL_URL: process.env.VERCEL_URL || 'https://test.vercel.app',
      TIMEOUT: 30000
    }
  },
  
  // Verbose output
  verbose: true,
  
  // Bail configuration
  bail: 0,
  
  // Clear mocks between tests
  clearMocks: true,
  
  // Restore mocks after each test
  restoreMocks: true,
  
  // Force exit after tests complete
  forceExit: true,
  
  // Detect leaked handles
  detectLeaks: false,
  
  // Maximum worker pools
  maxWorkers: '50%',
  
  // Cache directory
  cacheDirectory: './node_modules/.cache/jest',
  
  // Watch plugins
  watchPlugins: [
    'jest-watch-typeahead/filename',
    'jest-watch-typeahead/testname'
  ],
  
  // Error on deprecated features
  errorOnDeprecated: true,
  
  // Notify mode
  notify: false,
  
  // Test result processor
  testResultsProcessor: './scripts/test-results-processor.js'
};