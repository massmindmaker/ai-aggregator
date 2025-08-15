# AI Aggregator - Marketplace for AI Solutions

AI Aggregator is a comprehensive marketplace platform for artificial intelligence solutions, designed to create an ecosystem connecting AI developers and consumers of their solutions.

## 🚀 Deployed Application

**Live Demo**: [https://ai-aggregator-gamma.vercel.app](https://ai-aggregator-gamma.vercel.app)

The application is a Russian-language AI marketplace platform ("Маркетплейс ИИ-решений") featuring:
- API marketplace for AI solutions
- Machine learning competitions
- Development request system
- Organization profiles and collaboration tools

## 📁 Project Structure

```
ai-aggregator/
├── aiag_back/              # Main backend API and React frontend
│   ├── api/                # Serverless API endpoints
│   ├── controllers/        # Business logic controllers
│   ├── models/            # Database schemas
│   ├── routes/            # API routing
│   ├── react-ui/          # React frontend application
│   └── middleware/        # Authentication and security
├── aiaghub/               # Central API hub service
│   ├── api/               # Hub API endpoints
│   ├── controllers/       # Hub controllers
│   └── lib/               # Shared utilities
├── serena/                # AI assistant integration
├── database/              # Database configuration and migrations
├── deployment/            # Deployment scripts and configs
├── testing/               # Comprehensive test suite
└── migration/             # Database migration scripts
```

## 🛠 Technology Stack

### Frontend
- **React** - Main UI framework
- **SCSS** - Styling and responsive design
- **Material-UI** - Component library
- **React Router** - Client-side routing

### Backend
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **MongoDB** - Primary database
- **JWT** - Authentication system
- **Vercel** - Serverless deployment platform

### DevOps & Infrastructure
- **Vercel** - Hosting and serverless functions
- **Vercel Blob** - File storage
- **YooKassa** - Payment processing
- **Yandex Cloud** - Additional cloud services
- **GitHub Actions** - CI/CD pipeline

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