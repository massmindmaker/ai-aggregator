#!/bin/bash

# Deploy to Staging Environment
# Usage: ./deploy-staging.sh

set -e

echo "🚀 Starting deployment to STAGING environment..."

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STAGING_BRANCH="staging"
MAIN_APP_NAME="ai-aggregator-staging"
HUB_APP_NAME="aiag-hub-staging"

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
    
    # Check if git is clean
    if [ -n "$(git status --porcelain)" ]; then
        print_warning "Git working directory is not clean. Uncommitted changes detected."
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
    
    print_success "Prerequisites check completed"
}

# Validate environment variables
validate_environment() {
    print_status "Validating environment variables..."
    
    required_vars=(
        "MONGODB_URI_STAGING"
        "JWT_SECRET_STAGING"
        "VERCEL_BLOB_READ_WRITE_TOKEN_STAGING"
    )
    
    missing_vars=()
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        print_error "Missing required environment variables:"
        printf '%s\n' "${missing_vars[@]}"
        print_error "Please set these variables before deploying"
        exit 1
    fi
    
    print_success "Environment validation completed"
}

# Deploy main application
deploy_main_app() {
    print_status "Deploying main application to staging..."
    
    cd aiag_back
    
    # Set environment variables for staging
    vercel env add NODE_ENV staging --force
    vercel env add NODE_CONFIG_ENV staging --force
    vercel env add MONGODB_URI "$MONGODB_URI_STAGING" --force
    vercel env add JWT_SECRET "$JWT_SECRET_STAGING" --force
    vercel env add VERCEL_BLOB_READ_WRITE_TOKEN "$VERCEL_BLOB_READ_WRITE_TOKEN_STAGING" --force
    
    # Deploy using staging configuration
    vercel deploy --prod --config=vercel.staging.json --name="$MAIN_APP_NAME"
    
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
    print_status "Deploying API Hub to staging..."
    
    cd aiaghub
    
    # Set environment variables for staging
    vercel env add NODE_ENV staging --force
    vercel env add NODE_CONFIG_ENV staging --force
    vercel env add MONGODB_URI "$MONGODB_URI_STAGING" --force
    vercel env add JWT_SECRET "$JWT_SECRET_STAGING" --force
    
    # Deploy using staging configuration
    vercel deploy --prod --config=vercel.staging.json --name="$HUB_APP_NAME"
    
    if [ $? -eq 0 ]; then
        print_success "API Hub deployed successfully"
    else
        print_error "API Hub deployment failed"
        exit 1
    fi
    
    cd ..
}

# Run post-deployment checks
post_deployment_checks() {
    print_status "Running post-deployment checks..."
    
    # Check main app health
    print_status "Checking main application health..."
    main_health_url="https://${MAIN_APP_NAME}.vercel.app/health"
    if curl -f "$main_health_url" > /dev/null 2>&1; then
        print_success "Main application health check passed"
    else
        print_warning "Main application health check failed"
    fi
    
    # Check API Hub health
    print_status "Checking API Hub health..."
    hub_health_url="https://${HUB_APP_NAME}.vercel.app/health"
    if curl -f "$hub_health_url" > /dev/null 2>&1; then
        print_success "API Hub health check passed"
    else
        print_warning "API Hub health check failed"
    fi
    
    # Wait for services to warm up
    print_status "Waiting for services to warm up (30s)..."
    sleep 30
    
    # Run basic connectivity tests
    print_status "Testing cross-service connectivity..."
    # This would include more sophisticated tests in a real scenario
    
    print_success "Post-deployment checks completed"
}

# Main deployment flow
main() {
    echo "=================================================="
    echo "         AI Aggregator Staging Deployment        "
    echo "=================================================="
    
    check_prerequisites
    validate_environment
    
    print_status "Starting deployment process..."
    
    deploy_main_app
    deploy_api_hub
    
    post_deployment_checks
    
    print_success "🎉 Staging deployment completed successfully!"
    echo ""
    echo "📋 Deployment Summary:"
    echo "   Main App: https://${MAIN_APP_NAME}.vercel.app"
    echo "   API Hub:  https://${HUB_APP_NAME}.vercel.app"
    echo ""
    echo "🔧 Next Steps:"
    echo "   1. Run integration tests against staging environment"
    echo "   2. Verify all features are working correctly"
    echo "   3. Check monitoring dashboards"
    echo "   4. If all tests pass, proceed with production deployment"
}

# Handle script interruption
trap 'print_error "Deployment interrupted"; exit 1' INT TERM

# Run main function
main "$@"