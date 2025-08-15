# AI Aggregator - Final Deployment Runbook

## Overview

This document provides comprehensive instructions for deploying the AI Aggregator platform to production. The platform consists of two main applications:

- **Main Application**: Frontend + Backend API (`ai-aggregator.vercel.app`)
- **API Hub**: Dedicated API Gateway (`aiag-hub.vercel.app`)

## Architecture

```
┌─────────────────────┐    ┌─────────────────────┐
│   Frontend (React)   │    │   API Hub           │
│   + Backend API      │◄──►│   (Serverless)      │
│   ai-aggregator.     │    │   aiag-hub.         │
│   vercel.app         │    │   vercel.app        │
└─────────────────────┘    └─────────────────────┘
           │                           │
           ▼                           ▼
┌─────────────────────────────────────────────────┐
│              MongoDB Atlas                      │
│              (Shared Database)                  │
└─────────────────────────────────────────────────┘
```

## Prerequisites

### 1. Required Tools
```bash
# Install Vercel CLI
npm install -g vercel

# Login to Vercel
vercel login
```

### 2. Environment Variables

Create the following environment variables in your system:

#### Staging Environment
```bash
export MONGODB_URI_STAGING="mongodb://..."
export JWT_SECRET_STAGING="your-staging-jwt-secret"
export VERCEL_BLOB_READ_WRITE_TOKEN_STAGING="your-staging-blob-token"
```

#### Production Environment
```bash
export MONGODB_URI_PRODUCTION="mongodb://..."
export JWT_SECRET_PRODUCTION="your-production-jwt-secret"
export VERCEL_BLOB_READ_WRITE_TOKEN_PRODUCTION="your-production-blob-token"
```

### 3. Domain Configuration

#### Custom Domains (Optional)
- `aiag.ai` → Main Application
- `hub.aiag.ai` → API Hub
- `api.aiag.ai` → API Hub (alternative)

## Deployment Environments

### Staging Environment
- **Main App**: `https://ai-aggregator-staging.vercel.app`
- **API Hub**: `https://aiag-hub-staging.vercel.app`
- **Purpose**: Testing and validation before production
- **Configuration**: Less strict security, debug logging enabled

### Production Environment
- **Main App**: `https://ai-aggregator.vercel.app`
- **API Hub**: `https://aiag-hub.vercel.app`
- **Purpose**: Live environment for end users
- **Configuration**: Maximum security, minimal logging

## Deployment Process

### Stage 1: Deploy to Staging

```bash
# Navigate to deployment directory
cd deployment

# Make scripts executable
chmod +x deploy-staging.sh deploy-production.sh

# Deploy to staging
./deploy-staging.sh
```

The staging deployment will:
1. ✅ Check prerequisites
2. ✅ Validate environment variables
3. ✅ Deploy main application
4. ✅ Deploy API hub
5. ✅ Run health checks
6. ✅ Verify cross-service connectivity

### Stage 2: Validation in Staging

Before deploying to production, validate:

#### Health Checks
```bash
# Check main application
curl https://ai-aggregator-staging.vercel.app/health

# Check API hub
curl https://aiag-hub-staging.vercel.app/health

# Check dashboard
curl https://aiag-hub-staging.vercel.app/dashboard
```

#### Functional Tests
- [ ] User registration and login
- [ ] API key generation and validation
- [ ] Cross-origin requests between apps
- [ ] File upload/download functionality
- [ ] Database connectivity

#### Performance Tests
- [ ] Response times < 2s for most endpoints
- [ ] No memory leaks during extended use
- [ ] Rate limiting working correctly

### Stage 3: Deploy to Production

```bash
# Deploy to production (requires confirmation)
./deploy-production.sh
```

The production deployment will:
1. ✅ Verify staging environment health
2. ✅ Check git status and branch
3. ✅ Request explicit confirmation
4. ✅ Create backup tag
5. ✅ Deploy main application
6. ✅ Deploy API hub
7. ✅ Run comprehensive health checks
8. ✅ Setup monitoring

## Configuration Details

### CORS Configuration

The platform supports multiple origins for different environments:

```javascript
// Production origins
[
  'https://ai-aggregator.vercel.app',
  'https://aiag-hub.vercel.app',
  'https://aiag.ai',
  'https://hub.aiag.ai'
]

// Staging origins
[
  'https://ai-aggregator-staging.vercel.app',
  'https://aiag-hub-staging.vercel.app',
  'http://localhost:3000'  // For development
]
```

### Security Headers

Both applications implement comprehensive security headers:

- **Content Security Policy (CSP)**: Prevents XSS attacks
- **X-Frame-Options**: Prevents clickjacking
- **X-Content-Type-Options**: Prevents MIME sniffing
- **Strict-Transport-Security**: Enforces HTTPS
- **Referrer-Policy**: Controls referrer information

### Rate Limiting

- **Main App**: 200 requests/minute per IP
- **API Hub**: 500 requests/minute per IP
- **Health Checks**: Exempt from rate limiting

## Monitoring and Alerting

### Health Check Endpoints

#### Main Application
- `GET /health` - Comprehensive health check
- `GET /health/ready` - Readiness probe
- `GET /health/live` - Liveness probe
- `GET /health/metrics` - Detailed metrics

#### API Hub
- `GET /health` - Basic health check
- `GET /dashboard?action=health` - Detailed health status
- `GET /dashboard?action=metrics` - Performance metrics

### Key Metrics to Monitor

1. **Response Time**
   - Target: < 2s for 95% of requests
   - Alert: > 5s for any request

2. **Error Rate**
   - Target: < 1% error rate
   - Alert: > 5% error rate

3. **Uptime**
   - Target: 99.9% uptime
   - Alert: Any downtime > 1 minute

4. **Database Connectivity**
   - Target: Always connected
   - Alert: Any connection failures

### Alerting Webhooks

Configure webhooks in production config:
```json
{
  "monitoring": {
    "alerting": {
      "enabled": true,
      "webhookUrl": "https://your-alerting-service.com/webhook",
      "thresholds": {
        "responseTime": 5000,
        "errorRate": 0.05
      }
    }
  }
}
```

## Rollback Procedures

### Quick Rollback (5 minutes)

If critical issues are detected:

```bash
# Find the previous production deployment
vercel ls ai-aggregator
vercel ls aiag-hub

# Promote previous deployment to production
vercel promote [DEPLOYMENT_URL] --scope=your-team
```

### Database Rollback (30 minutes)

If database migration issues occur:

1. **Stop all application traffic**
2. **Restore database from backup**
3. **Deploy previous application version**
4. **Verify data integrity**

### Git-based Rollback (15 minutes)

```bash
# Find the backup tag
git tag -l "production-backup-*"

# Reset to previous version
git reset --hard production-backup-YYYYMMDD_HHMMSS

# Redeploy
./deploy-production.sh
```

## Troubleshooting

### Common Issues

#### 1. CORS Errors
**Symptoms**: Frontend cannot connect to API Hub
**Solution**: 
- Check CORS configuration in both applications
- Verify domain names in allowed origins
- Check browser console for specific error messages

#### 2. Environment Variable Issues
**Symptoms**: Application starts but features don't work
**Solution**:
- Verify all environment variables are set in Vercel dashboard
- Check variable names match configuration files
- Ensure no typos in sensitive values

#### 3. Database Connection Issues
**Symptoms**: Health checks fail, API errors
**Solution**:
- Check MongoDB connection string
- Verify database server is accessible
- Check firewall and IP whitelist settings

#### 4. Rate Limiting Issues
**Symptoms**: Users getting 429 errors
**Solution**:
- Check rate limiting configuration
- Monitor actual request patterns
- Adjust limits if legitimate traffic

### Debug Commands

```bash
# Check deployment status
vercel ls

# View deployment logs
vercel logs [DEPLOYMENT_URL]

# Check environment variables
vercel env ls

# Test specific endpoints
curl -v https://ai-aggregator.vercel.app/health
curl -v https://aiag-hub.vercel.app/health
```

## Custom Domain Setup

### 1. Configure Domains in Vercel

```bash
# Add custom domain to main app
vercel domains add aiag.ai --project ai-aggregator

# Add custom domain to API hub
vercel domains add hub.aiag.ai --project aiag-hub
```

### 2. DNS Configuration

Add the following DNS records:

```
# For main application (aiag.ai)
Type: CNAME
Name: @
Value: cname.vercel-dns.com

# For API hub (hub.aiag.ai)
Type: CNAME
Name: hub
Value: cname.vercel-dns.com
```

### 3. SSL Certificates

Vercel automatically provisions SSL certificates for custom domains. Monitor certificate status in the Vercel dashboard.

## Post-Deployment Checklist

### Immediate (0-15 minutes)
- [ ] Health checks pass for both applications
- [ ] Cross-service communication working
- [ ] Frontend loads correctly
- [ ] API endpoints responding
- [ ] Authentication working

### Short-term (15-60 minutes)
- [ ] Monitor error rates
- [ ] Check response times
- [ ] Verify database performance
- [ ] Test critical user flows
- [ ] Check monitoring dashboards

### Medium-term (1-24 hours)
- [ ] Monitor for memory leaks
- [ ] Check for unusual traffic patterns
- [ ] Verify all scheduled tasks running
- [ ] Review application logs
- [ ] Confirm alerting is working

## Contact Information

### Emergency Contacts
- **DevOps Lead**: [Your contact information]
- **Database Admin**: [Your contact information]
- **Platform Owner**: [Your contact information]

### Support Channels
- **Primary**: [Your support channel]
- **Secondary**: [Your backup channel]
- **Escalation**: [Your escalation process]

---

**Last Updated**: 2025-08-13
**Version**: 2.0.0
**Next Review**: 2025-09-13