# AI Aggregator Platform

🚀 **Comprehensive AI Tools Marketplace and API Hub**

[![Live Demo](https://img.shields.io/badge/Demo-Live-brightgreen)](https://aiaghub.vercel.app)
[![Frontend](https://img.shields.io/badge/Frontend-Live-blue)](https://ai-aggregator-gamma.vercel.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/Database-MongoDB%20%7C%20PostgreSQL-orange)](https://www.mongodb.com/)
[![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black)](https://vercel.com)

## 🌟 Overview

AI Aggregator is a comprehensive platform that serves as a central hub for discovering, managing, and integrating AI tools and services. It combines a modern React frontend with a robust Node.js backend, featuring both traditional and serverless architectures for optimal performance and scalability.

## ✨ Key Features

### 🎯 Core Platform
- **AI Tools Marketplace** - Discover and manage AI tools and services
- **API Hub** - Centralized API proxy and management system
- **User Management** - Complete authentication and user profile system
- **Organization Management** - Multi-organization support and management
- **Contest System** - AI competitions and challenges platform
- **Feed System** - Social features and content sharing

### 🏗️ Architecture
- **Dual Database Support** - MongoDB Atlas & Vercel PostgreSQL
- **Serverless Functions** - Optimized for Vercel edge deployment
- **API Proxy Hub** - Rate limiting, caching, and monitoring
- **Microservices Ready** - Modular, scalable architecture
- **Cloud Native** - Built for modern cloud deployment

### 🔧 Technical Features
- **Real-time Analytics** - Performance monitoring and metrics
- **Advanced Caching** - Multi-layer caching strategy
- **Rate Limiting** - API protection and fair usage
- **Security First** - CORS, CSP, and comprehensive security headers
- **SEO Optimized** - Server-side rendering and meta optimization

## 🚀 Live Deployments

| Service | URL | Description |
|---------|-----|-------------|
| **API Hub** | [aiaghub.vercel.app](https://aiaghub.vercel.app) | Main API gateway and services |
| **Frontend** | [ai-aggregator-gamma.vercel.app](https://ai-aggregator-gamma.vercel.app) | React-based user interface |
| **Health Check** | [aiaghub.vercel.app/health](https://aiaghub.vercel.app/health) | System status monitoring |

## 📁 Project Structure

```
ai-aggregator/
├── 📁 aiag_back/                  # Main Backend Service
│   ├── 📁 api/                    # API endpoints
│   ├── 📁 react-ui/               # React frontend application
│   ├── 📁 controllers/            # Business logic controllers
│   ├── 📁 models/                 # Database models and schemas
│   ├── 📁 routes/                 # Express.js route definitions
│   ├── 📁 middleware/             # Authentication, rate limiting, etc.
│   └── 📄 vercel.json             # Vercel deployment configuration
│
├── 📁 aiaghub/                    # Serverless API Hub
│   ├── 📁 api/                    # Serverless functions
│   ├── 📁 controllers/            # API proxy logic
│   ├── 📁 lib/                    # Shared utilities
│   ├── 📁 middleware/             # Serverless middleware
│   └── 📄 vercel.json             # Hub-specific Vercel config
│
├── 📁 database/                   # Database Management
│   ├── 📁 mongodb/                # MongoDB Atlas configuration
│   ├── 📁 postgres/               # Vercel PostgreSQL setup
│   └── 📁 healthcheck/            # Database monitoring
│
├── 📁 testing/                    # Comprehensive Test Suite
│   ├── 📁 tests/unit/             # Unit tests
│   ├── 📁 tests/integration/      # Integration tests
│   ├── 📁 tests/performance/      # Load and performance tests
│   └── 📁 cypress/                # End-to-end tests
│
├── 📁 deployment/                 # Deployment Scripts
├── 📁 .github/workflows/          # CI/CD Pipeline
└── 📁 serena/                     # AI Assistant Integration
```

## 🛠️ Technology Stack

### Frontend
- **React 18** - Modern UI library with hooks
- **Material-UI** - Component library and design system
- **SCSS/CSS3** - Styling and responsive design
- **Webpack** - Module bundling and optimization

### Backend
- **Node.js 20+** - JavaScript runtime
- **Express.js** - Web application framework
- **MongoDB** - Primary document database
- **PostgreSQL** - Relational data storage
- **Vercel Functions** - Serverless deployment

### Infrastructure
- **Vercel** - Hosting and serverless functions
- **MongoDB Atlas** - Cloud database service
- **Vercel Postgres** - Serverless PostgreSQL
- **GitHub Actions** - CI/CD automation

### APIs & Services
- **RESTful APIs** - Standard HTTP API design
- **JWT Authentication** - Secure token-based auth
- **Rate Limiting** - API protection
- **Caching Layer** - Performance optimization

## 🎯 Key Features

### For API Consumers
- **Marketplace Discovery** - Browse and search AI solutions
- **Sandbox Testing** - Test APIs before integration
- **SDK Integration** - Multiple language support
- **Usage Analytics** - Monitor API consumption
- **Flexible Pricing** - Various subscription plans

### For API Developers
- **API Publishing** - Easy API registration and documentation
- **Endpoint Management** - Configure and manage API endpoints
- **Revenue Tracking** - Monitor earnings and usage statistics
- **Developer Tools** - Testing and debugging utilities

### For ML Practitioners
- **Competitions** - Machine learning contests with prizes
- **Leaderboards** - Real-time ranking systems
- **Dataset Management** - Upload and manage training data
- **Automated Evaluation** - Custom metric evaluation

### For Service Requesters
- **Project Posting** - Create development requests
- **Contractor Selection** - Review and choose developers
- **Project Management** - Track progress and milestones
- **Quality Assurance** - Review and acceptance workflows

## 🏢 User Types & Roles

1. **Guest Users** - Browse marketplace and public content
2. **Registered Users** - Access full platform features
3. **API Developers** - Publish and monetize AI solutions
4. **Competition Organizers** - Create and manage ML contests
5. **Service Requesters** - Post development requirements
6. **Organization Owners** - Manage team profiles and products

## 🚀 Getting Started

### Prerequisites
- Node.js 16+
- MongoDB database
- Vercel account (for deployment)

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/[username]/ai-aggregator.git
   cd ai-aggregator
   ```

2. **Install dependencies**
   ```bash
   cd aiag_back
   npm install
   cd react-ui
   npm install
   ```

3. **Environment setup**
   ```bash
   cp .env.example .env
   # Configure your environment variables
   ```

4. **Start development servers**
   ```bash
   # Backend
   cd aiag_back
   npm start
   
   # Frontend
   cd react-ui
   npm start
   ```

### Deployment

The application is configured for Vercel deployment:

```bash
# Deploy to production
vercel --prod

# Deploy to staging
vercel
```

## 📊 Business Model

### Revenue Streams
- **API Usage Fees** - Commission on API calls
- **Subscription Plans** - Premium features for developers
- **Competition Hosting** - Fees for organizing contests
- **Service Marketplace** - Commission on completed projects

### Target Markets
- **AI/ML Developers** - Monetize their solutions
- **Businesses** - Find and integrate AI capabilities
- **Data Scientists** - Participate in competitions
- **Startups** - Access AI tools and talent

## 🔒 Security Features

- **JWT Authentication** - Secure user sessions
- **Rate Limiting** - API abuse protection
- **Input Validation** - SQL injection prevention
- **CORS Configuration** - Cross-origin security
- **Environment Isolation** - Separate staging/production

## 📈 Analytics & Monitoring

- **Usage Metrics** - API call tracking
- **Performance Monitoring** - Response time analysis
- **Error Tracking** - Automated error reporting
- **Business Intelligence** - Revenue and user analytics

## 🧪 Testing

Comprehensive test suite including:
- **Unit Tests** - Component and function testing
- **Integration Tests** - API endpoint testing
- **End-to-End Tests** - Full user journey testing
- **Performance Tests** - Load and stress testing
- **Security Tests** - Vulnerability assessment

```bash
# Run all tests
cd testing
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:e2e
```

## 📚 Documentation

- [Deployment Guide](VERCEL_DEPLOYMENT_GUIDE.md)
- [Database Migration](DATABASE_MIGRATION_GUIDE.md)
- [API Documentation](PROJECT_DOCUMENTATION.md)
- [Testing Guide](testing/README.md)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For support and questions:
- Create an issue in this repository
- Check the documentation files
- Review the deployment guides

## 🌟 Acknowledgments

- Built with [Claude Code](https://claude.ai/code)
- Deployed on [Vercel](https://vercel.com)
- Powered by the AI/ML community

---

**Live Demo**: [https://ai-aggregator-gamma.vercel.app](https://ai-aggregator-gamma.vercel.app)