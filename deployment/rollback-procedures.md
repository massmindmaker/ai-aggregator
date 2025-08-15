# Rollback Procedures for AIAG Platform

## Overview

This document outlines comprehensive rollback procedures for the AIAG platform, covering application deployments, database changes, configuration updates, and infrastructure modifications.

## Rollback Types and Procedures

### 1. Application Deployment Rollback

#### Vercel Deployment Rollback

**Immediate Rollback (< 5 minutes)**
```bash
# List recent deployments
vercel list --project=ai-aggregator
vercel list --project=aiag-hub

# Rollback to previous deployment
vercel rollback [deployment-url] --project=ai-aggregator
vercel rollback [deployment-url] --project=aiag-hub

# Verify rollback
curl -f https://aiag.ai/api/health
curl -f https://hub.aiag.ai/health
```

**CLI-based Rollback Script**
```bash
#!/bin/bash
# rollback-deployment.sh

PROJECT=$1
DEPLOYMENT_ID=$2

if [ -z "$PROJECT" ] || [ -z "$DEPLOYMENT_ID" ]; then
    echo "Usage: ./rollback-deployment.sh <project> <deployment-id>"
    echo "Example: ./rollback-deployment.sh ai-aggregator abc123def456"
    exit 1
fi

echo "Rolling back $PROJECT to deployment $DEPLOYMENT_ID..."

# Perform rollback
vercel rollback $DEPLOYMENT_ID --project=$PROJECT --yes

# Wait for deployment
sleep 30

# Verify health
if [ "$PROJECT" = "ai-aggregator" ]; then
    HEALTH_URL="https://aiag.ai/api/health"
elif [ "$PROJECT" = "aiag-hub" ]; then
    HEALTH_URL="https://hub.aiag.ai/health"
else
    echo "Unknown project: $PROJECT"
    exit 1
fi

# Check health endpoint
for i in {1..10}; do
    if curl -f "$HEALTH_URL" > /dev/null 2>&1; then
        echo "✓ Rollback successful - $PROJECT is healthy"
        exit 0
    else
        echo "Waiting for $PROJECT to become healthy... ($i/10)"
        sleep 10
    fi
done

echo "✗ Rollback may have failed - $PROJECT is not responding"
exit 1
```

#### Git-based Rollback
```bash
# Rollback to specific commit
git log --oneline -10  # Find the commit to rollback to
git checkout [commit-hash]

# Create rollback branch
git checkout -b rollback-[timestamp]
git push origin rollback-[timestamp]

# Deploy rollback branch
vercel --prod --branch rollback-[timestamp]
```

### 2. Database Rollback

#### MongoDB Rollback

**Point-in-Time Recovery (MongoDB Atlas)**
1. **Access MongoDB Atlas Console**
   - Navigate to cluster overview
   - Click "Backup" tab
   - Select "Restore"

2. **Choose Recovery Point**
   ```bash
   # Get available restore points
   atlas backups restores list --clusterName [cluster-name]
   
   # Initiate point-in-time restore
   atlas backups restores start --clusterName [cluster-name] \
     --pointInTimeUTCSeconds [timestamp] \
     --targetClusterName [restore-cluster-name]
   ```

3. **Switch Application to Restored Database**
   ```bash
   # Update environment variable
   vercel env add MONGODB_URI [new-connection-string] production
   
   # Redeploy applications
   vercel --prod --project ai-aggregator
   vercel --prod --project aiag-hub
   ```

**Manual Backup Restore**
```bash
# Restore from local backup
mongorestore --uri="mongodb+srv://[connection-string]" \
  --drop [backup-directory]

# Restore specific database
mongorestore --uri="mongodb+srv://[connection-string]" \
  --db [database-name] --drop [backup-directory]/[database-name]
```

#### PostgreSQL Rollback

**Restore from Backup**
```bash
# List available backups
vercel postgres backup list

# Create new database instance
vercel postgres create [new-database-name]

# Restore from backup
pg_restore -d [new-database-url] [backup-file]

# Update environment variables
vercel env add DATABASE_URL [new-database-url] production
```

**Point-in-Time Recovery**
```bash
# If using continuous archiving
pg_ctl stop -D /data/postgres
pg_ctl start -D /data/postgres -o "-r [restore-point]"
```

### 3. Configuration Rollback

#### Environment Variables Rollback
```bash
# Backup current environment variables
vercel env ls production > env-backup-$(date +%Y%m%d_%H%M%S).txt

# Restore from previous backup
cat env-backup-[timestamp].txt | while read line; do
    if [[ $line == *"="* ]]; then
        key=$(echo $line | cut -d'=' -f1)
        value=$(echo $line | cut -d'=' -f2-)
        vercel env add $key "$value" production
    fi
done
```

#### Vercel Configuration Rollback
```bash
# Rollback vercel.json changes
git checkout HEAD~1 -- aiag_back/vercel.json
git checkout HEAD~1 -- aiaghub/vercel.json

# Commit and deploy
git add .
git commit -m "rollback: revert vercel.json changes"
git push origin main
```

#### DNS Configuration Rollback
```bash
# Revert DNS records
# This is typically done through domain registrar interface

# Verify DNS propagation
dig aiag.ai
dig hub.aiag.ai

# Force DNS cache clear (if needed)
sudo systemctl flush-dns  # Linux
sudo dscacheutil -flushcache  # macOS
```

### 4. Infrastructure Rollback

#### Complete Infrastructure Rollback

**Scenario: Major Infrastructure Change Failure**

1. **Prepare Rollback Environment**
   ```bash
   # Clone to rollback directory
   git clone https://github.com/[repo] aiag-rollback
   cd aiag-rollback
   
   # Checkout last known good state
   git checkout [last-good-commit]
   ```

2. **Deploy Rollback Infrastructure**
   ```bash
   # Deploy both applications
   cd aiag_back
   vercel --prod --name ai-aggregator-rollback
   
   cd ../aiaghub
   vercel --prod --name aiag-hub-rollback
   ```

3. **Update DNS (if needed)**
   ```bash
   # Point domains to rollback deployments
   vercel domains add aiag.ai --project ai-aggregator-rollback
   vercel domains add hub.aiag.ai --project aiag-hub-rollback
   ```

4. **Restore Database State**
   ```bash
   # Restore databases to previous state
   # Follow database rollback procedures above
   ```

### 5. Monitoring and Alerting Rollback

#### Disable New Monitoring
```bash
# Revert monitoring configuration
git checkout HEAD~1 -- deployment/monitoring-configuration.json

# Remove monitoring scripts
rm -f deployment/health-check-monitoring.js

# Update alerting webhooks to rollback channels
vercel env add SLACK_WEBHOOK_URL [rollback-webhook-url] production
```

#### Revert Security Changes
```bash
# Rollback security headers
git checkout HEAD~1 -- aiag_back/vercel.json
git checkout HEAD~1 -- aiaghub/vercel.json

# Revert rate limiting
git checkout HEAD~1 -- aiag_back/middleware/ratelimit.middleware.js
```

## Rollback Decision Matrix

| Issue Severity | Rollback Type | Max Downtime | Approval Required |
|----------------|---------------|--------------|-------------------|
| Critical Production Bug | Immediate deployment rollback | 5 minutes | No |
| Data Corruption | Database point-in-time restore | 30 minutes | Yes (CTO) |
| Security Vulnerability | Immediate deployment + config rollback | 10 minutes | No |
| Performance Degradation | Gradual rollback | 15 minutes | No |
| Feature Issues | Deployment rollback | 10 minutes | Yes (Product) |
| Infrastructure Failure | Complete infrastructure rollback | 2 hours | Yes (CTO) |

## Rollback Testing Procedures

### Staging Environment Testing
```bash
# Test rollback procedures in staging
./test-rollback-staging.sh

# Validate rollback scripts
./validate-rollback-procedures.sh

# Performance test after rollback
./run-performance-tests.sh
```

### Rollback Simulation Script
```bash
#!/bin/bash
# rollback-simulation.sh

echo "Starting rollback simulation..."

# 1. Deploy intentionally broken version to staging
echo "Deploying broken version..."
git checkout staging
echo "console.log('BROKEN');" >> aiag_back/api/index.js
git add .
git commit -m "test: simulate broken deployment"
git push origin staging

# 2. Wait for deployment
sleep 60

# 3. Verify it's broken
if curl -f https://staging.aiag.ai/api/health; then
    echo "ERROR: Expected broken deployment to fail health check"
    exit 1
fi

# 4. Perform rollback
echo "Performing rollback..."
LAST_GOOD_COMMIT=$(git log --oneline -2 | tail -1 | cut -d' ' -f1)
git checkout $LAST_GOOD_COMMIT
git checkout -b rollback-test-$(date +%s)
git push origin rollback-test-$(date +%s)

# 5. Deploy rollback
vercel --prod --branch rollback-test-$(date +%s) --project ai-aggregator-staging

# 6. Wait for deployment
sleep 60

# 7. Verify rollback success
if curl -f https://staging.aiag.ai/api/health; then
    echo "✓ Rollback simulation successful"
    exit 0
else
    echo "✗ Rollback simulation failed"
    exit 1
fi
```

## Automated Rollback Triggers

### Health Check Based Rollback
```javascript
// auto-rollback.js
const HealthCheckMonitor = require('./health-check-monitoring');

class AutoRollback {
  constructor() {
    this.failureThreshold = 3; // consecutive failures
    this.failureCount = new Map();
  }

  async checkAndRollback(serviceName, healthResult) {
    if (!healthResult.healthy) {
      const currentCount = this.failureCount.get(serviceName) || 0;
      this.failureCount.set(serviceName, currentCount + 1);

      if (currentCount + 1 >= this.failureThreshold) {
        console.log(`Triggering auto-rollback for ${serviceName}`);
        await this.performAutomaticRollback(serviceName);
        this.failureCount.set(serviceName, 0);
      }
    } else {
      this.failureCount.set(serviceName, 0);
    }
  }

  async performAutomaticRollback(serviceName) {
    const project = serviceName === 'ai-aggregator' ? 'ai-aggregator' : 'aiag-hub';
    
    // Get previous deployment
    const { exec } = require('child_process');
    const deployments = await new Promise((resolve, reject) => {
      exec(`vercel list --project=${project} --json`, (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      });
    });

    const previousDeployment = deployments[1]; // Second most recent
    
    if (previousDeployment) {
      await new Promise((resolve, reject) => {
        exec(`vercel rollback ${previousDeployment.url} --project=${project} --yes`, 
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
      });

      // Send alert about automatic rollback
      await this.sendRollbackAlert(serviceName, previousDeployment.url);
    }
  }
}
```

### Error Rate Based Rollback
```javascript
// Monitor error rate and trigger rollback if > 5%
setInterval(async () => {
  const errorRate = await getErrorRate();
  if (errorRate > 0.05) { // 5%
    await triggerRollback('High error rate detected');
  }
}, 60000); // Check every minute
```

## Rollback Verification Procedures

### Post-Rollback Checklist
- [ ] Application health checks passing
- [ ] Database connectivity verified
- [ ] Critical user journeys tested
- [ ] Performance metrics within normal range
- [ ] Error rates back to baseline
- [ ] Monitoring and alerting functional
- [ ] SSL certificates valid
- [ ] DNS resolution correct

### Verification Scripts
```bash
#!/bin/bash
# verify-rollback.sh

echo "Verifying rollback success..."

# Health checks
curl -f https://aiag.ai/api/health || exit 1
curl -f https://hub.aiag.ai/health || exit 1

# Database connectivity
curl -f https://aiag.ai/api/users/test-connection || exit 1
curl -f https://hub.aiag.ai/api/test-connection || exit 1

# Critical endpoints
curl -f https://aiag.ai/api/products || exit 1
curl -f https://hub.aiag.ai/hub/models || exit 1

# Performance check
RESPONSE_TIME=$(curl -o /dev/null -s -w '%{time_total}' https://aiag.ai)
if (( $(echo "$RESPONSE_TIME > 2.0" | bc -l) )); then
    echo "WARNING: Response time is high: ${RESPONSE_TIME}s"
fi

echo "✓ Rollback verification completed successfully"
```

## Communication During Rollback

### Internal Communication Template
```
🔄 ROLLBACK IN PROGRESS

Service: [Service Name]
Reason: [Brief description]
Estimated Duration: [X minutes]
Impact: [Description of user impact]

Actions Taken:
- [Action 1]
- [Action 2]

Next Update: [Time]
```

### External Communication Template
```
We are currently experiencing issues with our service and are working to resolve them quickly. We apologize for any inconvenience.

Status: Investigating
ETA: [X minutes]
Updates: [Status page URL]
```

## Rollback Documentation

### Post-Rollback Report Template
```markdown
# Rollback Report - [Date]

## Summary
- **Incident**: [Brief description]
- **Rollback Trigger**: [What caused the rollback]
- **Services Affected**: [List of services]
- **Duration**: [Total downtime]
- **User Impact**: [Description]

## Timeline
- **[Time]**: Issue detected
- **[Time]**: Rollback initiated
- **[Time]**: Rollback completed
- **[Time]**: Services verified healthy

## Root Cause
[Detailed explanation of what went wrong]

## Rollback Actions Taken
1. [Action 1]
2. [Action 2]
3. [Action 3]

## Lessons Learned
- [Lesson 1]
- [Lesson 2]

## Prevention Measures
- [Prevention 1]
- [Prevention 2]

## Follow-up Actions
- [ ] [Action 1]
- [ ] [Action 2]
```

## Emergency Contacts

| Role | Primary | Secondary |
|------|---------|-----------|
| On-Call Engineer | +1-XXX-XXX-XXXX | +1-XXX-XXX-XXXX |
| DevOps Lead | +1-XXX-XXX-XXXX | +1-XXX-XXX-XXXX |
| CTO | +1-XXX-XXX-XXXX | +1-XXX-XXX-XXXX |

## Quick Reference Commands

```bash
# Emergency rollback (saves to clipboard)
echo "vercel rollback \$(vercel list --project=ai-aggregator | head -2 | tail -1 | awk '{print \$1}') --project=ai-aggregator --yes" | pbcopy

# Health check all services
curl -f https://aiag.ai/api/health && curl -f https://hub.aiag.ai/health && echo "All services healthy"

# Get recent deployments
vercel list --project=ai-aggregator | head -5
vercel list --project=aiag-hub | head -5

# Emergency DNS switch (to maintenance page)
# dig aiag.ai +trace
```