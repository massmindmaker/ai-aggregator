const mongoose = require('mongoose');

/**
 * MongoDB Atlas Configuration for AI Aggregator
 * Optimized for Vercel serverless deployment with connection pooling
 */

class MongoAtlasConnection {
    constructor() {
        this.connection = null;
        this.isConnecting = false;
    }

    /**
     * Get MongoDB connection string from environment variables
     */
    getConnectionString() {
        const {
            MONGODB_ATLAS_URI,
            MONGODB_ATLAS_USERNAME,
            MONGODB_ATLAS_PASSWORD,
            MONGODB_ATLAS_DATABASE
        } = process.env;

        if (MONGODB_ATLAS_URI) {
            return MONGODB_ATLAS_URI;
        }

        if (!MONGODB_ATLAS_USERNAME || !MONGODB_ATLAS_PASSWORD || !MONGODB_ATLAS_DATABASE) {
            throw new Error('MongoDB Atlas credentials not found in environment variables');
        }

        return `mongodb+srv://${MONGODB_ATLAS_USERNAME}:${MONGODB_ATLAS_PASSWORD}@cluster0.mongodb.net/${MONGODB_ATLAS_DATABASE}?retryWrites=true&w=majority`;
    }

    /**
     * Connection options optimized for serverless environment
     */
    getConnectionOptions() {
        return {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            // Serverless optimization
            maxPoolSize: 10, // Maximum number of connections
            minPoolSize: 2,  // Minimum number of connections
            maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
            serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
            socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
            family: 4, // Use IPv4, skip trying IPv6
            // Buffer optimization
            bufferMaxEntries: 0, // Disable mongoose buffering
            bufferCommands: false, // Disable mongoose buffering
            // Connection management
            connectTimeoutMS: 30000,
            heartbeatFrequencyMS: 10000,
        };
    }

    /**
     * Connect to MongoDB Atlas with connection pooling
     */
    async connect() {
        // Return existing connection if available
        if (this.connection && mongoose.connection.readyState === 1) {
            return this.connection;
        }

        // Prevent multiple connection attempts
        if (this.isConnecting) {
            while (this.isConnecting) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return this.connection;
        }

        try {
            this.isConnecting = true;
            
            const connectionString = this.getConnectionString();
            const options = this.getConnectionOptions();

            console.log('Connecting to MongoDB Atlas...');
            
            this.connection = await mongoose.connect(connectionString, options);
            
            console.log('Connected to MongoDB Atlas successfully');
            
            // Connection event handlers
            mongoose.connection.on('error', (err) => {
                console.error('MongoDB Atlas connection error:', err);
            });

            mongoose.connection.on('disconnected', () => {
                console.log('MongoDB Atlas disconnected');
                this.connection = null;
            });

            mongoose.connection.on('reconnected', () => {
                console.log('MongoDB Atlas reconnected');
            });

            return this.connection;
        } catch (error) {
            console.error('Failed to connect to MongoDB Atlas:', error);
            this.connection = null;
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Disconnect from MongoDB Atlas
     */
    async disconnect() {
        if (this.connection) {
            await mongoose.disconnect();
            this.connection = null;
            console.log('Disconnected from MongoDB Atlas');
        }
    }

    /**
     * Health check for MongoDB connection
     */
    async healthCheck() {
        try {
            if (!this.connection || mongoose.connection.readyState !== 1) {
                return { status: 'disconnected', message: 'No active connection' };
            }

            // Simple ping to test connection
            await mongoose.connection.db.admin().ping();
            
            return {
                status: 'connected',
                readyState: mongoose.connection.readyState,
                host: mongoose.connection.host,
                name: mongoose.connection.name
            };
        } catch (error) {
            return {
                status: 'error',
                message: error.message
            };
        }
    }
}

// Singleton instance
const mongoAtlas = new MongoAtlasConnection();

module.exports = mongoAtlas;