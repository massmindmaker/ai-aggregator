# AI Aggregator Testing Suite

Comprehensive testing framework for migrating AI Aggregator from Yandex Cloud to Vercel serverless infrastructure.

## Overview

This testing suite provides end-to-end validation for the migration process, including:

- **Unit Tests**: Component-level testing for serverless functions, authentication, and database operations
- **Integration Tests**: API endpoint testing, database integration, and Vercel Blob storage
- **End-to-End Tests**: Complete user journey validation using Cypress
- **Performance Tests**: Cold start optimization, load testing, and scaling validation
- **Security Tests**: Authentication security, input validation, and vulnerability scanning
- **Migration Tests**: Data migration validation, rollback procedures, and system verification

## Quick Start

### Prerequisites

- Node.js 18+ 
- Docker (for test databases)
- Vercel CLI
- Git

### Installation

```bash
# Install dependencies
cd testing
npm install

# Setup environment variables
cp .env.example .env
# Edit .env with your configuration

# Setup test databases
npm run db:setup
```

### Running Tests

```bash
# Run all tests
npm run test:all

# Run specific test types
npm run test:unit           # Unit tests
npm run test:integration    # Integration tests  
npm run test:e2e           # End-to-end tests
npm run test:performance   # Performance tests
npm run test:security      # Security tests

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

## Test Structure

```
testing/
├── tests/
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   ├── performance/       # Performance tests
│   └── security/          # Security tests
├── cypress/
│   └── e2e/              # End-to-end tests
├── scripts/              # Test utilities and CI/CD scripts
├── setup/                # Test configuration
└── reports/              # Generated test reports
```

## CI/CD Integration

### GitHub Actions Workflows

1. **ci-testing.yml**: Main testing pipeline
   - Unit/Integration/Performance/Security tests
   - Vercel deployment testing
   - Test result aggregation

2. **migration-pipeline.yml**: Migration-specific workflow
   - Pre-migration validation
   - Database and file migration
   - Post-migration verification
   - Rollback procedures

3. **scheduled-tests.yml**: Monitoring and maintenance
   - Daily health checks
   - Weekly comprehensive testing
   - Monthly performance baselines

### Manual Workflow Triggers

```bash
# Trigger migration pipeline
gh workflow run migration-pipeline.yml -f migration_type=staging -f dry_run=true

# Run specific test type
gh workflow run scheduled-tests.yml -f test_type=performance
```

## Migration Testing

### Pre-Migration

```bash
# Validate system readiness
npm run test:migration:dependencies
npm run test:migration:backup-validation
npm run test:pre-migration
```

### During Migration

```bash
# Test database migration
npm run test:migration:data-consistency

# Validate file migration
npm run test:files:migration

# Test deployment
npm run test:deployment:validation
```

### Post-Migration

```bash
# Full verification
npm run test:migration:verification
npm run test:performance:post-migration
npm run test:final:validation
```

### Rollback Testing

```bash
# Test rollback procedures
npm run test:rollback:validation
node scripts/rollback-procedures.js --dry-run

# Execute rollback (if needed)
node scripts/rollback-procedures.js full
```

## Performance Testing

### Serverless Function Performance

```bash
# Cold start testing
npm run test:performance:cold-start

# Sustained load testing  
npm run test:performance:sustained

# Scaling behavior
npm run test:performance:scaling
```

### Load Testing with Artillery

```bash
# Basic load test
npm run test:load

# Custom load test
artillery run tests/performance/load-test.yml --environment production
```

## Security Testing

### Automated Security Scans

```bash
# Input validation testing
npm run test:security:validation

# Authentication security
npm run test:security:auth

# Penetration testing
npm run test:security:penetration
```

### Vulnerability Scanning

```bash
# Dependency audit
npm run test:security:vulnerability

# OWASP ZAP scan (requires ZAP)
docker run -t owasp/zap2docker-stable zap-baseline.py -t https://your-app.vercel.app
```

## Test Data Management

### Seeding Test Data

```bash
# Seed comprehensive test data
node scripts/test-data-seeder.js seed

# Cleanup test data
node scripts/test-data-seeder.js cleanup

# Reseed (cleanup + seed)
node scripts/test-data-seeder.js reseed
```

### Test Data Types

- Users (admin, developer, regular users)
- Organizations and memberships
- Products and API definitions
- API keys and permissions
- Files and metadata
- Analytics data
- Contest and request data

## Environment Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Database URLs
MONGODB_TEST_URI=mongodb://localhost:27017/aiag_test
POSTGRES_TEST_URI=postgresql://localhost:5432/aiag_hub_test

# Vercel Configuration
VERCEL_TOKEN=your_token
VERCEL_PROJECT_ID=your_project_id
VERCEL_BLOB_TOKEN=your_blob_token

# Test Targets
LOCAL_URL=http://localhost:3000
VERCEL_URL=https://your-app.vercel.app
PRODUCTION_URL=https://your-app.com
```

### Test Environments

- **Local**: Development testing with local services
- **Staging**: Pre-production Vercel environment
- **Production**: Live system monitoring and smoke tests

## Monitoring and Reporting

### Test Reports

Reports are generated in `testing/reports/`:

- `summary.md`: Human-readable test summary
- `detailed-report.json`: Detailed test results
- `performance-metrics.json`: Performance data
- `coverage-summary.json`: Code coverage data

### Health Monitoring

```bash
# Check system health
npm run test:health

# Monitor production
npm run test:health:production

# 24-hour monitoring
npm run monitoring:24h
```

### Alerting

Configure Slack webhooks in `.env`:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
SLACK_WEBHOOK_CRITICAL=https://hooks.slack.com/services/YOUR/CRITICAL/WEBHOOK
```

## Troubleshooting

### Common Issues

1. **Database Connection Errors**
   ```bash
   # Restart test databases
   docker restart mongo-test postgres-test
   npm run db:setup
   ```

2. **Vercel Deployment Failures**
   ```bash
   # Check Vercel token
   npx vercel whoami --token=$VERCEL_TOKEN
   
   # Validate configuration
   npm run test:migration:vercel-config
   ```

3. **Test Timeouts**
   ```bash
   # Increase timeout in jest.config.js
   testTimeout: 60000
   
   # For specific tests
   jest.setTimeout(120000)
   ```

### Debug Mode

```bash
# Run with debug output
DEBUG=* npm run test:integration

# Cypress debug mode
npm run test:e2e:open

# Performance profiling
NODE_ENV=test npm run test:performance -- --verbose
```

## Contributing

### Adding New Tests

1. Create test files in appropriate directories
2. Follow existing naming conventions
3. Include setup/teardown procedures
4. Update test scripts in package.json
5. Document test purpose and usage

### Test Guidelines

- Use descriptive test names
- Include both positive and negative test cases
- Test edge cases and error conditions
- Ensure tests are independent and deterministic
- Clean up test data after execution

### Performance Considerations

- Mock external services in unit tests
- Use test databases for integration tests
- Implement proper timeouts
- Monitor test execution time
- Parallelize where possible

## Migration Checklist

### Before Migration

- [ ] Run pre-migration validation
- [ ] Create system backups
- [ ] Validate rollback procedures
- [ ] Test migration scripts in staging
- [ ] Ensure monitoring is configured

### During Migration

- [ ] Monitor migration progress
- [ ] Validate data consistency
- [ ] Test system functionality
- [ ] Monitor performance metrics
- [ ] Be ready for quick rollback

### After Migration

- [ ] Run comprehensive test suite
- [ ] Validate all user journeys
- [ ] Monitor system health
- [ ] Update DNS and routing
- [ ] Generate migration report

## Support

For issues and questions:

1. Check the troubleshooting section
2. Review GitHub Actions logs
3. Check test reports in `testing/reports/`
4. Contact the development team

## License

This testing suite is part of the AI Aggregator project and follows the same license terms.