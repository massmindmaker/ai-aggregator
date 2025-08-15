# AI Aggregator - Technical Architecture

## Directory Structure
- **aiag_back/**: Main backend API and React frontend
- **aiaghub/**: Central API hub service  
- **serena/**: AI assistant integration
- **database/**: Database configurations and migrations
- **deployment/**: Deployment scripts and configurations
- **testing/**: Comprehensive test suite

## Technology Stack

### Frontend
- **Framework**: React
- **Styling**: SCSS, Material-UI
- **Build Tool**: Create React App
- **Deployment**: Vercel static hosting

### Backend
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT-based authentication
- **Architecture**: Serverless functions on Vercel

### Storage & External Services
- **File Storage**: Vercel Blob, Yandex Cloud
- **Payments**: YooKassa integration
- **Email**: Custom email verification system
- **API Management**: Custom rate limiting and middleware

## Deployment Architecture
- **Platform**: Vercel serverless
- **Frontend**: Static React build
- **API**: Serverless functions in /api directory
- **Database**: MongoDB Atlas
- **CDN**: Vercel Edge Network
- **Custom Domains**: Configured through Vercel
