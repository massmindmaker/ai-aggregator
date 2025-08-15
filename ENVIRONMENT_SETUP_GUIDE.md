# Environment Setup Guide

## Quick Setup for Final Deployment

### 1. Required Environment Variables

Create these environment variables on your system before running deployment scripts:

#### For Staging Deployment
```bash
# Database
export MONGODB_URI_STAGING="mongodb+srv://username:password@cluster.mongodb.net/aiag_staging?retryWrites=true&w=majority"

# Authentication
export JWT_SECRET_STAGING="your-secure-jwt-secret-for-staging-min-32-chars"

# File Storage
export VERCEL_BLOB_READ_WRITE_TOKEN_STAGING="vercel_blob_rw_token_staging"

# Optional: Additional services
export OPENAI_API_KEY_STAGING="sk-your-openai-api-key"
export YOOKASSA_SHOP_ID_STAGING="your-yookassa-shop-id"
export YOOKASSA_SECRET_KEY_STAGING="your-yookassa-secret"
```

#### For Production Deployment
```bash
# Database
export MONGODB_URI_PRODUCTION="mongodb+srv://username:password@cluster.mongodb.net/aiag_production?retryWrites=true&w=majority"

# Authentication  
export JWT_SECRET_PRODUCTION="your-secure-jwt-secret-for-production-min-32-chars"

# File Storage
export VERCEL_BLOB_READ_WRITE_TOKEN_PRODUCTION="vercel_blob_rw_token_production"

# Optional: Additional services
export OPENAI_API_KEY_PRODUCTION="sk-your-openai-api-key"
export YOOKASSA_SHOP_ID_PRODUCTION="your-yookassa-shop-id"
export YOOKASSA_SECRET_KEY_PRODUCTION="your-yookassa-secret"
```

### 2. How to Set Environment Variables

#### On macOS/Linux:
```bash
# Add to ~/.bashrc or ~/.zshrc
echo 'export MONGODB_URI_STAGING="your-connection-string"' >> ~/.bashrc
source ~/.bashrc
```

#### On Windows (PowerShell):
```powershell
# Set environment variable for current session
$env:MONGODB_URI_STAGING="your-connection-string"

# Set permanent environment variable
[Environment]::SetEnvironmentVariable("MONGODB_URI_STAGING", "your-connection-string", "User")
```

#### On Windows (Command Prompt):
```cmd
set MONGODB_URI_STAGING=your-connection-string
```

### 3. Vercel Project Setup

#### Initialize Vercel Projects
```bash
# Main application
cd aiag_back
vercel link
# Choose: Link to existing project
# Select: ai-aggregator (or create new)

# API Hub
cd ../aiaghub  
vercel link
# Choose: Link to existing project
# Select: aiag-hub (or create new)
```

#### Set Environment Variables in Vercel Dashboard

Alternative to using deployment scripts, you can set variables manually:

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project
3. Go to Settings → Environment Variables
4. Add the following variables:

**For ai-aggregator project:**
```
NODE_ENV = production
NODE_CONFIG_ENV = production
MONGODB_URI = [your production mongodb uri]
JWT_SECRET = [your production jwt secret]
VERCEL_BLOB_READ_WRITE_TOKEN = [your production blob token]
```

**For aiag-hub project:**
```
NODE_ENV = production  
NODE_CONFIG_ENV = production
MONGODB_URI = [your production mongodb uri]
JWT_SECRET = [your production jwt secret]
```

### 4. Database Setup

#### MongoDB Atlas Configuration

1. **Create Database Clusters**:
   - Staging: `aiag_staging`
   - Production: `aiag_production`

2. **Network Access**:
   - Add `0.0.0.0/0` for Vercel deployments
   - Or specific Vercel IP ranges if available

3. **Database Users**:
   - Create separate users for staging and production
   - Use different passwords for each environment

4. **Connection Strings Format**:
   ```
   mongodb+srv://<username>:<password>@<cluster>/<database>?retryWrites=true&w=majority
   ```

### 5. Vercel Blob Storage Setup

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to Storage tab
3. Create Blob Storage if not exists
4. Copy the Read/Write token
5. Use different storage instances for staging and production if needed

### 6. Validation Script

Create this script to validate your environment setup:

```bash
#!/bin/bash
# validate-env.sh

echo "🔍 Validating environment setup..."

# Check required variables
required_staging=(
    "MONGODB_URI_STAGING"
    "JWT_SECRET_STAGING" 
    "VERCEL_BLOB_READ_WRITE_TOKEN_STAGING"
)

required_production=(
    "MONGODB_URI_PRODUCTION"
    "JWT_SECRET_PRODUCTION"
    "VERCEL_BLOB_READ_WRITE_TOKEN_PRODUCTION"
)

echo "📋 Checking Staging Variables:"
for var in "${required_staging[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Missing: $var"
    else
        echo "✅ Present: $var"
    fi
done

echo "📋 Checking Production Variables:"
for var in "${required_production[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Missing: $var"
    else
        echo "✅ Present: $var"
    fi
done

echo "🔧 Checking Tools:"
if command -v vercel &> /dev/null; then
    echo "✅ Vercel CLI installed"
    if vercel whoami &> /dev/null; then
        echo "✅ Logged in to Vercel"
    else
        echo "❌ Not logged in to Vercel"
    fi
else
    echo "❌ Vercel CLI not installed"
fi

echo "✨ Environment validation complete!"
```

### 7. Security Notes

- **Never commit secrets to git**
- **Use different secrets for each environment**
- **Rotate secrets regularly**
- **Use strong, randomly generated JWT secrets (min 32 characters)**
- **Enable database access logs in production**

### 8. Quick Deployment Commands

Once environment is set up:

```bash
# Deploy to staging
./deployment/deploy-staging.sh

# After staging validation, deploy to production
./deployment/deploy-production.sh
```

### 9. Troubleshooting Environment Issues

#### If deployment fails with environment errors:

1. **Check variable names**:
   ```bash
   echo $MONGODB_URI_PRODUCTION
   ```

2. **Verify Vercel project linking**:
   ```bash
   vercel ls
   ```

3. **Check Vercel environment variables**:
   ```bash
   vercel env ls
   ```

4. **Test database connection locally**:
   ```bash
   mongosh "$MONGODB_URI_STAGING"
   ```

### 10. Post-Setup Verification

After setting up environment variables:

```bash
# Test staging environment
curl https://ai-aggregator-staging.vercel.app/health

# Test production environment (after deployment)
curl https://ai-aggregator.vercel.app/health
```

---

**🎯 Ready to Deploy!**

Once all environment variables are set and validated, you're ready to run the deployment scripts and go live with your AI Aggregator platform.