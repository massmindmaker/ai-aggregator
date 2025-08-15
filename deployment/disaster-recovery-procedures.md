# Disaster Recovery Procedures for AIAG Infrastructure

## Overview

This document outlines the disaster recovery procedures for the AIAG platform, including both the main application (ai-aggregator) and the API hub (aiag-hub) deployed on Vercel.

## Infrastructure Components

### Applications
- **ai-aggregator**: Main application (aiag.ai)
- **aiag-hub**: API Hub (hub.aiag.ai)

### Data Stores
- **MongoDB Atlas**: Primary database (production & staging)
- **Vercel Postgres**: Secondary/specific data (production & staging)
- **Vercel Blob**: File storage

### External Services
- **Vercel**: Hosting platform
- **GitHub**: Source code repository
- **Domain registrar**: DNS management

## Recovery Time Objectives (RTO) and Recovery Point Objectives (RPO)

| Component | RTO | RPO | Priority |
|-----------|-----|-----|----------|
| Main Application | 15 minutes | 5 minutes | Critical |
| API Hub | 30 minutes | 15 minutes | High |
| Database | 1 hour | 1 hour | Critical |
| File Storage | 2 hours | 24 hours | Medium |

## Disaster Scenarios and Response

### 1. Application Downtime

#### Symptoms
- Health checks failing
- 5xx errors from applications
- Users unable to access services

#### Immediate Response (0-5 minutes)
1. **Verify the issue**
   ```bash
   curl -I https://aiag.ai/api/health
   curl -I https://hub.aiag.ai/health
   ```

2. **Check Vercel status**
   - Visit: https://vercel-status.com
   - Check deployment logs in Vercel dashboard

3. **Check recent deployments**
   ```bash
   vercel list --project=ai-aggregator
   vercel list --project=aiag-hub
   ```

#### Short-term Recovery (5-15 minutes)
1. **Rollback to last known good deployment**
   ```bash
   # Get deployment ID from Vercel dashboard or CLI
   vercel rollback [deployment-url] --project=ai-aggregator
   vercel rollback [deployment-url] --project=aiag-hub
   ```

2. **Verify rollback success**
   ```bash
   curl -I https://aiag.ai/api/health
   curl -I https://hub.aiag.ai/health
   ```

3. **Update DNS if needed (domain issues)**
   - Check DNS propagation: https://whatsmydns.net
   - Verify DNS records point to correct Vercel endpoints

#### Long-term Recovery (15+ minutes)
1. **Investigate root cause**
   - Review Vercel function logs
   - Check application logs
   - Analyze error patterns

2. **Fix and redeploy**
   ```bash
   git checkout main
   git pull origin main
   # Fix issues
   git add .
   git commit -m "fix: resolve production issue"
   git push origin main
   # Automatic deployment via GitHub integration
   ```

### 2. Database Failure

#### MongoDB Atlas Failure

**Immediate Response**
1. **Check Atlas status**
   - Visit MongoDB Atlas dashboard
   - Check cluster health and connectivity

2. **Verify connection strings**
   ```bash
   # Test connection from local environment
   mongosh "mongodb+srv://cluster.mongodb.net/test" --username [username]
   ```

**Recovery Steps**
1. **Use MongoDB Atlas automatic failover**
   - Atlas provides automatic failover to secondary nodes
   - Typical failover time: 1-2 minutes

2. **If automatic failover fails**
   ```bash
   # Switch to backup cluster (if configured)
   # Update MONGODB_URI environment variable in Vercel
   vercel env add MONGODB_URI [backup-connection-string] production
   ```

3. **Restore from backup if needed**
   - Download latest backup from Atlas
   - Create new cluster
   - Restore data
   - Update connection strings

#### Vercel Postgres Failure

**Immediate Response**
1. **Check Vercel Postgres status**
   - Visit Vercel dashboard
   - Check database connection logs

2. **Verify connection**
   ```bash
   psql [DATABASE_URL]
   \l  # List databases
   \dt # List tables
   ```

**Recovery Steps**
1. **Use Vercel automatic recovery**
   - Vercel Postgres has built-in redundancy
   - Automatic failover typically takes 2-5 minutes

2. **Manual recovery**
   ```bash
   # If automatic recovery fails, create new database
   # Restore from latest backup
   pg_restore -d [new_database_url] [backup_file]
   
   # Update environment variables
   vercel env add DATABASE_URL [new_database_url] production
   ```

### 3. DNS/Domain Issues

#### Symptoms
- Domain not resolving
- SSL certificate errors
- Redirect loops

#### Recovery Steps
1. **Check DNS status**
   ```bash
   dig aiag.ai
   dig hub.aiag.ai
   nslookup aiag.ai
   ```

2. **Verify Vercel domain configuration**
   ```bash
   vercel domains ls
   vercel domains verify aiag.ai
   vercel domains verify hub.aiag.ai
   ```

3. **Update DNS records if needed**
   - Login to domain registrar
   - Verify CNAME records point to `cname.vercel-dns.com`
   - Update TTL to 300 seconds for faster propagation

4. **SSL certificate renewal**
   ```bash
   # Vercel handles SSL automatically, but can force renewal
   vercel certs issue aiag.ai
   vercel certs issue hub.aiag.ai
   ```

### 4. Complete Infrastructure Failure

#### Immediate Actions (0-30 minutes)
1. **Activate emergency communication**
   - Notify stakeholders via pre-defined channels
   - Update status page (if available)

2. **Assess scope of failure**
   - Check all services and dependencies
   - Determine if issue is Vercel-wide or application-specific

3. **Implement temporary measures**
   - Deploy static maintenance page
   - Redirect traffic to backup infrastructure (if available)

#### Recovery Process (30+ minutes)
1. **Prepare new deployment environment**
   ```bash
   # Create new Vercel projects if needed
   vercel --version
   vercel login
   vercel init
   ```

2. **Deploy from source control**
   ```bash
   git clone https://github.com/[repository]
   cd aiag_back
   vercel --prod
   
   cd ../aiaghub
   vercel --prod
   ```

3. **Restore data**
   - Restore databases from latest backups
   - Restore file storage from Vercel Blob backups
   - Update connection strings and environment variables

4. **Update DNS**
   - Point domains to new deployment URLs
   - Wait for DNS propagation (up to 48 hours, typically 15 minutes)

## Backup Procedures

### Automated Backups

#### Database Backups
1. **MongoDB Atlas**
   - Continuous backup enabled by default
   - Point-in-time recovery available
   - Snapshots taken every 6 hours
   - Retention: 30 days

2. **Vercel Postgres**
   - Daily automated backups
   - Retention: 7 days
   - Manual snapshots before major deployments

#### Application Code
1. **GitHub Repository**
   - All code changes automatically backed up
   - Branch protection enabled for main/production branches
   - Multiple developers have access

2. **Vercel Deployment History**
   - All deployments preserved indefinitely
   - Can rollback to any previous deployment
   - Deployment artifacts stored securely

### Manual Backup Procedures

#### Database Manual Backup
```bash
# MongoDB backup
mongodump --uri="mongodb+srv://[connection-string]" --out=/backup/mongodb/$(date +%Y%m%d)

# PostgreSQL backup
pg_dump [DATABASE_URL] > backup_$(date +%Y%m%d_%H%M%S).sql
```

#### Application Configuration Backup
```bash
# Export environment variables
vercel env ls production > env_backup_$(date +%Y%m%d).txt

# Download deployment source
vercel download [deployment-id] --output=./backup/deployment_$(date +%Y%m%d)
```

## Recovery Testing

### Monthly Recovery Drills
1. **Simulate application failure**
   - Deploy intentionally broken code to staging
   - Practice rollback procedures
   - Measure recovery time

2. **Database recovery testing**
   - Restore staging database from production backup
   - Verify data integrity
   - Test application functionality

3. **DNS failover testing**
   - Update staging DNS to point to different endpoints
   - Test propagation time
   - Verify SSL certificate provisioning

### Quarterly Full Recovery Test
1. **Complete infrastructure recreation**
   - Deploy to new Vercel account
   - Restore all data from backups
   - Update DNS to point to new infrastructure
   - Measure total recovery time

## Communication Procedures

### Emergency Contacts
| Role | Primary Contact | Secondary Contact |
|------|----------------|-------------------|
| System Administrator | admin@aiag.ai | +1-XXX-XXX-XXXX |
| Development Lead | dev@massmindmakers.com | +1-XXX-XXX-XXXX |
| Business Owner | owner@aiag.ai | +1-XXX-XXX-XXXX |

### Communication Channels
1. **Internal Notifications**
   - Slack: #alerts channel
   - Email: alerts@massmindmakers.com
   - SMS: Critical issues only

2. **External Communication**
   - Status page updates
   - Social media notifications
   - Customer email notifications

### Communication Templates

#### Incident Start
```
INCIDENT ALERT - AIAG Service Disruption

Status: Investigating
Services Affected: [Service names]
Start Time: [Timestamp]
Impact: [Description of user impact]

We are investigating reports of service disruption and will provide updates every 15 minutes.

Updates: [status page URL]
```

#### Resolution
```
INCIDENT RESOLVED - AIAG Services Restored

Status: Resolved
Services Affected: [Service names]
Duration: [Total downtime]
Root Cause: [Brief explanation]

All services have been restored to normal operation. We apologize for any inconvenience caused.

Post-mortem report will be available within 48 hours.
```

## Prevention Measures

### Monitoring and Alerting
1. **Proactive monitoring**
   - Health checks every 30 seconds
   - Performance monitoring
   - Error rate alerting

2. **Capacity planning**
   - Monitor resource usage trends
   - Scale infrastructure proactively
   - Load testing before major releases

### Security Measures
1. **Access controls**
   - Multi-factor authentication for all admin accounts
   - Regular access reviews
   - Principle of least privilege

2. **Security monitoring**
   - Failed login attempt monitoring
   - Unusual activity detection
   - Regular security audits

### Change Management
1. **Deployment practices**
   - Blue-green deployments
   - Gradual rollouts
   - Automated testing before production

2. **Configuration management**
   - Infrastructure as Code
   - Environment parity
   - Change approval processes

## Post-Incident Procedures

### Immediate Post-Recovery (0-4 hours)
1. **Verify full restoration**
   - Run comprehensive health checks
   - Test critical user journeys
   - Monitor for recurring issues

2. **Preserve evidence**
   - Save logs and error messages
   - Document timeline of events
   - Capture monitoring data

### Post-Mortem Process (24-48 hours)
1. **Conduct blameless post-mortem**
   - Document what happened
   - Analyze root cause
   - Identify contributing factors

2. **Create action items**
   - Immediate fixes
   - Medium-term improvements
   - Long-term prevention measures

3. **Update procedures**
   - Revise recovery procedures based on lessons learned
   - Update monitoring and alerting
   - Improve prevention measures

### Follow-up (1-2 weeks)
1. **Implement improvements**
   - Execute action items from post-mortem
   - Update documentation
   - Conduct additional testing

2. **Review with stakeholders**
   - Share post-mortem report
   - Discuss prevention measures
   - Update service level objectives if needed

## Tools and Resources

### Essential Tools
- **Vercel CLI**: Deployment and management
- **Git**: Source code management
- **MongoDB Compass**: Database management
- **psql**: PostgreSQL command line
- **curl**: API testing
- **dig/nslookup**: DNS troubleshooting

### Documentation Links
- Vercel Documentation: https://vercel.com/docs
- MongoDB Atlas Documentation: https://docs.atlas.mongodb.com
- GitHub Documentation: https://docs.github.com

### Recovery Scripts
```bash
# Quick health check script
#!/bin/bash
echo "Checking application health..."
curl -f https://aiag.ai/api/health || echo "Main app failed"
curl -f https://hub.aiag.ai/health || echo "Hub failed"

# Quick rollback script
#!/bin/bash
echo "Rolling back to previous deployment..."
vercel rollback --yes --project=ai-aggregator
vercel rollback --yes --project=aiag-hub
```

## Appendix

### A. Emergency Checklist
- [ ] Verify issue scope and impact
- [ ] Check external service status
- [ ] Attempt immediate remediation
- [ ] Notify stakeholders if downtime > 5 minutes
- [ ] Document all actions taken
- [ ] Implement fix and verify
- [ ] Conduct post-mortem review

### B. Key Metrics to Monitor
- Application response time (< 200ms target)
- Error rate (< 1% target)
- Database connection time (< 100ms target)
- SSL certificate expiry (30 days warning)
- Domain resolution time (< 50ms target)

### C. Version Information
- Document Version: 1.0
- Last Updated: 2025-01-XX
- Next Review Date: 2025-04-XX
- Owner: AIAG Infrastructure Team