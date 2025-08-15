const config = require('config');
const mongoAtlas = require('../mongodb/atlas-config');
const { getPostgresConnection } = require('../postgres/vercel-config');

/**
 * Database Adapter for AI Aggregator
 * Provides unified interface for MongoDB Atlas and Vercel Postgres
 */

class DatabaseAdapter {
    constructor() {
        this.mongoConnection = null;
        this.postgresConnection = null;
        this.isInitialized = false;
    }

    /**
     * Initialize database connections based on environment
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        try {
            console.log('🔧 Initializing database connections...');

            // Initialize MongoDB Atlas connection
            if (this.shouldUseMongoDB()) {
                this.mongoConnection = mongoAtlas;
                await this.mongoConnection.connect();
                console.log('✓ MongoDB Atlas connection established');
            }

            // Initialize PostgreSQL connection
            if (this.shouldUsePostgreSQL()) {
                this.postgresConnection = getPostgresConnection();
                await this.postgresConnection.getPool();
                console.log('✓ PostgreSQL connection established');
            }

            this.isInitialized = true;
            console.log('✓ Database adapter initialized successfully');

        } catch (error) {
            console.error('✗ Failed to initialize database adapter:', error);
            throw error;
        }
    }

    /**
     * Check if MongoDB should be used
     */
    shouldUseMongoDB() {
        return process.env.MONGODB_ATLAS_URI || 
               config.has('mongoUri') || 
               process.env.NODE_ENV !== 'test';
    }

    /**
     * Check if PostgreSQL should be used
     */
    shouldUsePostgreSQL() {
        return process.env.POSTGRES_URL || 
               process.env.DATABASE_URL || 
               config.has('database.postgres');
    }

    /**
     * Get MongoDB connection
     */
    async getMongoDB() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        if (!this.mongoConnection) {
            throw new Error('MongoDB connection not available');
        }

        return this.mongoConnection;
    }

    /**
     * Get PostgreSQL connection
     */
    async getPostgreSQL() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        if (!this.postgresConnection) {
            throw new Error('PostgreSQL connection not available');
        }

        return this.postgresConnection;
    }

    /**
     * Health check for all databases
     */
    async healthCheck() {
        const health = {
            timestamp: new Date().toISOString(),
            status: 'healthy',
            databases: {}
        };

        try {
            // MongoDB health check
            if (this.mongoConnection) {
                const mongoHealth = await this.mongoConnection.healthCheck();
                health.databases.mongodb = mongoHealth;
                
                if (mongoHealth.status !== 'connected') {
                    health.status = 'degraded';
                }
            }

            // PostgreSQL health check
            if (this.postgresConnection) {
                const pgHealth = await this.postgresConnection.healthCheck();
                health.databases.postgresql = pgHealth;
                
                if (pgHealth.status !== 'connected') {
                    health.status = 'degraded';
                }
            }

            return health;
        } catch (error) {
            health.status = 'error';
            health.error = error.message;
            return health;
        }
    }

    /**
     * Get connection statistics
     */
    getConnectionStats() {
        const stats = {
            mongodb: null,
            postgresql: null
        };

        if (this.mongoConnection) {
            stats.mongodb = {
                status: 'connected',
                readyState: require('mongoose').connection.readyState
            };
        }

        if (this.postgresConnection) {
            stats.postgresql = this.postgresConnection.getPoolStats();
        }

        return stats;
    }

    /**
     * Graceful shutdown of all connections
     */
    async shutdown() {
        console.log('🔌 Shutting down database connections...');

        try {
            // Close MongoDB connection
            if (this.mongoConnection) {
                await this.mongoConnection.disconnect();
                console.log('✓ MongoDB connection closed');
            }

            // Close PostgreSQL connection
            if (this.postgresConnection) {
                await this.postgresConnection.disconnect();
                console.log('✓ PostgreSQL connection closed');
            }

            this.isInitialized = false;
            console.log('✓ Database adapter shutdown completed');

        } catch (error) {
            console.error('✗ Error during database shutdown:', error);
            throw error;
        }
    }

    /**
     * Test database migrations
     */
    async testMigrations() {
        const results = {
            mongodb: { status: 'skipped' },
            postgresql: { status: 'skipped' }
        };

        try {
            // Test MongoDB connection and collections
            if (this.mongoConnection) {
                const mongoose = require('mongoose');
                const collections = await mongoose.connection.db.listCollections().toArray();
                results.mongodb = {
                    status: 'success',
                    collections: collections.length,
                    collectionNames: collections.map(c => c.name)
                };
            }

            // Test PostgreSQL connection and tables
            if (this.postgresConnection) {
                const tablesResult = await this.postgresConnection.query(`
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public'
                `);
                results.postgresql = {
                    status: 'success',
                    tables: tablesResult.rowCount,
                    tableNames: tablesResult.rows.map(r => r.table_name)
                };
            }

            return results;
        } catch (error) {
            console.error('Migration test failed:', error);
            throw error;
        }
    }
}

// Environment-specific configurations
const environmentConfig = {
    development: {
        mongodb: {
            useAtlas: false,
            localUri: 'mongodb://localhost:27017/aiag_dev'
        },
        postgresql: {
            useVercel: false,
            localUri: 'postgresql://localhost:5432/aiag_dev'
        }
    },
    production: {
        mongodb: {
            useAtlas: true,
            requireSSL: true
        },
        postgresql: {
            useVercel: true,
            requireSSL: true
        }
    },
    test: {
        mongodb: {
            useAtlas: false,
            localUri: 'mongodb://localhost:27017/aiag_test'
        },
        postgresql: {
            useVercel: false,
            localUri: 'postgresql://localhost:5432/aiag_test'
        }
    }
};

/**
 * Get environment-specific database configuration
 */
function getDatabaseConfig() {
    const env = process.env.NODE_ENV || 'development';
    return environmentConfig[env] || environmentConfig.development;
}

/**
 * Utility functions for database operations
 */
const dbOperations = {
    /**
     * Execute MongoDB aggregation pipeline
     */
    async aggregateMongoDB(collection, pipeline) {
        const adapter = new DatabaseAdapter();
        const mongo = await adapter.getMongoDB();
        const mongoose = require('mongoose');
        return await mongoose.connection.db.collection(collection).aggregate(pipeline).toArray();
    },

    /**
     * Execute PostgreSQL analytical query
     */
    async analyzePostgreSQL(query, params = []) {
        const adapter = new DatabaseAdapter();
        const postgres = await adapter.getPostgreSQL();
        return await postgres.query(query, params);
    },

    /**
     * Cross-database analytics
     */
    async getCrossDbAnalytics(dateRange = '30 days') {
        const adapter = new DatabaseAdapter();
        const analytics = {};

        try {
            // MongoDB analytics (user activity, products, contests)
            if (adapter.shouldUseMongoDB()) {
                const mongo = await adapter.getMongoDB();
                const mongoose = require('mongoose');
                
                analytics.mongodb = {
                    users: await mongoose.connection.db.collection('users').countDocuments(),
                    products: await mongoose.connection.db.collection('products').countDocuments(),
                    contests: await mongoose.connection.db.collection('contests').countDocuments()
                };
            }

            // PostgreSQL analytics (API usage, requests)
            if (adapter.shouldUsePostgreSQL()) {
                const postgres = await adapter.getPostgreSQL();
                
                const apiStatsResult = await postgres.query(`
                    SELECT 
                        COUNT(*) as total_requests,
                        COUNT(DISTINCT uid) as unique_users,
                        AVG(latency) as avg_latency
                    FROM request 
                    WHERE date >= NOW() - INTERVAL '${dateRange}'
                `);
                
                analytics.postgresql = apiStatsResult.rows[0];
            }

            return analytics;
        } catch (error) {
            console.error('Cross-database analytics failed:', error);
            throw error;
        }
    }
};

// Singleton instance
let databaseAdapter = null;

/**
 * Get shared database adapter instance
 */
function getDatabaseAdapter() {
    if (!databaseAdapter) {
        databaseAdapter = new DatabaseAdapter();
    }
    return databaseAdapter;
}

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
    if (databaseAdapter) {
        await databaseAdapter.shutdown();
    }
});

process.on('SIGINT', async () => {
    if (databaseAdapter) {
        await databaseAdapter.shutdown();
    }
});

module.exports = {
    DatabaseAdapter,
    getDatabaseAdapter,
    getDatabaseConfig,
    dbOperations,
    environmentConfig
};