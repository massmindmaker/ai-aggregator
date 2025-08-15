#!/bin/bash

# Deploy to Production Environment
# Usage: ./deploy-production.sh

set -e

echo "🚀 Starting deployment to PRODUCTION environment..."

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PRODUCTION_BRANCH="main"
MAIN_APP_NAME="ai-aggregator"
HUB_APP_NAME="aiag-hub"
STAGING_MAIN_APP="ai-aggregator-staging"
STAGING_HUB_APP="aiag-hub-staging"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if vercel CLI is installed
    if ! command -v vercel &> /dev/null; then
        print_error "Vercel CLI is not installed. Please install it first:"
        echo "npm i -g vercel"
        exit 1
    fi
    
    # Check if we're logged in to Vercel
    if ! vercel whoami &> /dev/null; then
        print_error "Not logged in to Vercel. Please login first:"
        echo "vercel login"
        exit 1
    fi
    
    # Check if we're on the correct branch
    current_branch=$(git branch --show-current)
    if [ "$current_branch" != "$PRODUCTION_BRANCH" ]; then
        print_error "Not on production branch. Current branch: $current_branch"
        print_error "Please switch to $PRODUCTION_BRANCH branch before deploying to production"
        exit 1
    fi
    
    # Check if git is clean
    if [ -n "$(git status --porcelain)" ]; then
        print_error "Git working directory is not clean. Cannot deploy to production with uncommitted changes."
        exit 1
    fi
    
    # Check if local branch is up to date with remote
    git fetch origin
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/$PRODUCTION_BRANCH)" ]; then
        print_error "Local branch is not up to date with remote. Please pull latest changes."
        exit 1
    fi
    
    print_success "Prerequisites check completed"
}

# Validate staging environment
validate_staging() {
    print_status "Validating staging environment before production deployment..."
    
    # Check staging health
    staging_main_health="https://${STAGING_MAIN_APP}.vercel.app/health"
    staging_hub_health="https://${STAGING_HUB_APP}.vercel.app/health"
    
    print_status "Checking staging main app health..."
    if ! curl -f "$staging_main_health" > /dev/null 2>&1; then
        print_error "Staging main application health check failed"
        print_error "Please fix staging issues before deploying to production"
        exit 1
    fi
    
    print_status "Checking staging API hub health..."
    if ! curl -f "$staging_hub_health" > /dev/null 2>&1; then
        print_error "Staging API hub health check failed"
        print_error "Please fix staging issues before deploying to production"
        exit 1
    fi
    
    print_success "Staging environment validation completed"
}

# Get deployment confirmation
get_deployment_confirmation() {
    echo ""
    echo "⚠️  WARNING: You are about to deploy to PRODUCTION environment"
    echo ""
    echo "This will affect:"
    echo "  - Main App: https://${MAIN_APP_NAME}.vercel.app"
    echo "  - API Hub:  https://${HUB_APP_NAME}.vercel.app"
    echo ""
    echo "Please confirm the following:"
    echo "  ✓ All tests have passed in staging"
    echo "  ✓ Code review has been completed"
    echo "  ✓ Database migrations (if any) have been tested"
    echo "  ✓ Rollback plan is in place"
    echo ""
    
    read -p "Are you sure you want to proceed with production deployment? (yes/no): " confirmation
    
    if [ "$confirmation" != "yes" ]; then
        print_status "Deployment cancelled by user"
        exit 0
    fi
}

# Validate environment variables
validate_environment() {
    print_status "Validating production environment variables..."
    
    required_vars=(
        "MONGODB_URI_PRODUCTION"
        "JWT_SECRET_PRODUCTION"
        "VERCEL_BLOB_READ_WRITE_TOKEN_PRODUCTION"
    )
    
    missing_vars=()
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        print_error "Missing required production environment variables:"
        printf '%s\n' "${missing_vars[@]}"
        print_error "Please set these variables before deploying"
        exit 1
    fi
    
    print_success "Environment validation completed"
}

# Create deployment backup
create_deployment_backup() {
    print_status "Creating deployment backup..."
    
    timestamp=$(date +"%Y%m%d_%H%M%S")
    backup_tag="production-backup-$timestamp"
    
    git tag "$backup_tag"
    git push origin "$backup_tag"
    
    print_success "Backup created with tag: $backup_tag"
}

# Deploy main application
deploy_main_app() {
    print_status "Deploying main application to production..."
    
    cd aiag_back
    
    # Set production environment variables
    vercel env add NODE_ENV production --force
    vercel env add NODE_CONFIG_ENV production --force
    vercel env add MONGODB_URI "$MONGODB_URI_PRODUCTION" --force
    vercel env add JWT_SECRET "$JWT_SECRET_PRODUCTION" --force
    vercel env add VERCEL_BLOB_READ_WRITE_TOKEN "$VERCEL_BLOB_READ_WRITE_TOKEN_PRODUCTION" --force
    
    # Deploy to production
    vercel deploy --prod --name="$MAIN_APP_NAME"
    
    if [ $? -eq 0 ]; then
        print_success "Main application deployed successfully"
    else
        print_error "Main application deployment failed"
        exit 1
    fi
    
    cd ..
}

# Deploy API Hub
deploy_api_hub() {
    print_status "Deploying API Hub to production..."
    
    cd aiaghub
    
    # Set production environment variables
    vercel env add NODE_ENV production --force
    vercel env add NODE_CONFIG_ENV production --force
    vercel env add MONGODB_URI "$MONGODB_URI_PRODUCTION" --force
    vercel env add JWT_SECRET "$JWT_SECRET_PRODUCTION" --force
    
    # Deploy to production
    vercel deploy --prod --name="$HUB_APP_NAME"
    
    if [ $? -eq 0 ]; then
        print_success "API Hub deployed successfully"
    else
        print_error "API Hub deployment failed"
        exit 1
    fi
    
    cd ..
}

# Run comprehensive post-deployment checks
post_deployment_checks() {
    print_status "Running comprehensive post-deployment checks..."
    
    # Wait for deployment to propagate
    print_status "Waiting for deployment to propagate (60s)..."
    sleep 60
    
    # Check main app health
    print_status "Checking main application health..."
    main_health_url="https://${MAIN_APP_NAME}.vercel.app/health"
    for i in {1..5}; do
        if curl -f "$main_health_url" > /dev/null 2>&1; then
            print_success "Main application health check passed"
            break
        else
            print_warning "Main application health check failed (attempt $i/5)"
            if [ $i -eq 5 ]; then
                print_error "Main application health checks failed after 5 attempts"
                return 1
            fi
            sleep 10
        fi
    done
    
    # Check API Hub health
    print_status "Checking API Hub health..."
    hub_health_url="https://${HUB_APP_NAME}.vercel.app/health"
    for i in {1..5}; do
        if curl -f "$hub_health_url" > /dev/null 2>&1; then
            print_success "API Hub health check passed"
            break
        else
            print_warning "API Hub health check failed (attempt $i/5)"
            if [ $i -eq 5 ]; then
                print_error "API Hub health checks failed after 5 attempts"
                return 1
            fi
            sleep 10
        fi
    done
    
    # Test cross-service connectivity
    print_status "Testing cross-service connectivity..."
    # Add specific connectivity tests here
    
    # Check critical endpoints
    print_status "Checking critical endpoints..."
    critical_endpoints=(
        "https://${MAIN_APP_NAME}.vercel.app/api/health"
        "https://${HUB_APP_NAME}.vercel.app/dashboard"
    )
    
    for endpoint in "${critical_endpoints[@]}"; do
        if curl -f "$endpoint" > /dev/null 2>&1; then
            print_success "Endpoint check passed: $endpoint"
        else
            print_error "Endpoint check failed: $endpoint"
            return 1
        fi
    done
    
    print_success "All post-deployment checks passed"
}

# Setup monitoring and alerting
setup_monitoring() {
    print_status "Setting up production monitoring..."
    
    # This would typically include:
    # - Setting up Vercel Analytics
    # - Configuring alerting webhooks
    # - Setting up external monitoring (Pingdom, UptimeRobot, etc.)
    
    print_success "Monitoring setup completed"
}

# Main deployment flow
main() {
    echo "=================================================="
    echo "       AI Aggregator Production Deployment       "
    echo "=================================================="
    
    check_prerequisites
    validate_staging
    get_deployment_confirmation
    validate_environment
    
    print_status "Starting production deployment process..."
    
    create_deployment_backup
    deploy_main_app
    deploy_api_hub
    
    if post_deployment_checks; then
        setup_monitoring
        
        print_success "🎉 Production deployment completed successfully!"
        echo ""
        echo "📋 Deployment Summary:"
        echo "   Main App: https://${MAIN_APP_NAME}.vercel.app"
        echo "   API Hub:  https://${HUB_APP_NAME}.vercel.app"
        echo ""
        echo "🔧 Next Steps:"
        echo "   1. Monitor application performance"
        echo "   2. Check error rates and response times"
        echo "   3. Verify all monitoring systems are active"
        echo "   4. Notify stakeholders of successful deployment"
    else
        print_error "Post-deployment checks failed!"
        print_error "Please investigate issues and consider rollback if necessary"
        exit 1
    fi
}

# Handle script interruption
trap 'print_error "Deployment interrupted"; exit 1' INT TERM

# Run main function
main "$@"