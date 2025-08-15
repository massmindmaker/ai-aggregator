const express = require('express');
const { getDatabaseAdapter } = require('../config/database-adapter');

/**
 * Database Health Check Endpoints
 * Provides monitoring and status endpoints for MongoDB Atlas and Vercel Postgres
 */

const router = express.Router();

/**
 * General health check endpoint
 * GET /health
 */
router.get('/health', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const health = await adapter.healthCheck();
        
        const statusCode = health.status === 'healthy' ? 200 : 
                          health.status === 'degraded' ? 206 : 500;
        
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Detailed database status
 * GET /health/detailed
 */
router.get('/health/detailed', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const [health, stats, migrations] = await Promise.all([
            adapter.healthCheck(),
            adapter.getConnectionStats(),
            adapter.testMigrations()
        ]);

        const detailedStatus = {
            ...health,
            connectionStats: stats,
            migrations,
            environment: process.env.NODE_ENV || 'development',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            platform: process.platform,
            nodeVersion: process.version
        };

        const statusCode = health.status === 'healthy' ? 200 : 
                          health.status === 'degraded' ? 206 : 500;

        res.status(statusCode).json(detailedStatus);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * MongoDB specific health check
 * GET /health/mongodb
 */
router.get('/health/mongodb', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const mongo = await adapter.getMongoDB();
        const health = await mongo.healthCheck();
        
        // Additional MongoDB specific checks
        if (health.status === 'connected') {
            const mongoose = require('mongoose');
            const collections = await mongoose.connection.db.listCollections().toArray();
            
            health.collections = {
                count: collections.length,
                names: collections.map(c => c.name)
            };

            // Sample data counts
            health.sampleCounts = {
                users: await mongoose.connection.db.collection('users').estimatedDocumentCount(),
                products: await mongoose.connection.db.collection('products').estimatedDocumentCount(),
                contests: await mongoose.connection.db.collection('contests').estimatedDocumentCount()
            };
        }

        const statusCode = health.status === 'connected' ? 200 : 500;
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * PostgreSQL specific health check
 * GET /health/postgresql
 */
router.get('/health/postgresql', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const postgres = await adapter.getPostgreSQL();
        const health = await postgres.healthCheck();
        
        // Additional PostgreSQL specific checks
        if (health.status === 'connected') {
            // Get table information
            const tablesResult = await postgres.query(`
                SELECT 
                    table_name,
                    (xpath('/row/cnt/text()', xml_count))[1]::text::int as row_count
                FROM (
                    SELECT 
                        table_name,
                        query_to_xml(format('select count(*) as cnt from %I.%I', table_schema, table_name), false, true, '') as xml_count
                    FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_type = 'BASE TABLE'
                    LIMIT 10
                ) t
            `);

            health.tables = tablesResult.rows;

            // Get recent activity
            const activityResult = await postgres.query(`
                SELECT 
                    COUNT(*) as requests_last_hour,
                    COUNT(DISTINCT uid) as unique_users_last_hour,
                    AVG(latency)::numeric(10,2) as avg_latency_last_hour
                FROM request 
                WHERE date >= NOW() - INTERVAL '1 hour'
            `);

            health.recentActivity = activityResult.rows[0];

            // Pool statistics
            health.poolStats = postgres.getPoolStats();
        }

        const statusCode = health.status === 'connected' ? 200 : 500;
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Performance metrics endpoint
 * GET /health/performance
 */
router.get('/health/performance', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const startTime = Date.now();

        // Test query performance
        const performanceTests = [];

        // MongoDB performance test
        if (adapter.shouldUseMongoDB()) {
            const mongoStart = Date.now();
            try {
                const mongo = await adapter.getMongoDB();
                const mongoose = require('mongoose');
                await mongoose.connection.db.collection('users').findOne({});
                const mongoTime = Date.now() - mongoStart;
                
                performanceTests.push({
                    database: 'mongodb',
                    test: 'simple_query',
                    duration_ms: mongoTime,
                    status: 'success'
                });
            } catch (error) {
                performanceTests.push({
                    database: 'mongodb',
                    test: 'simple_query',
                    duration_ms: Date.now() - mongoStart,
                    status: 'error',
                    error: error.message
                });
            }
        }

        // PostgreSQL performance test
        if (adapter.shouldUsePostgreSQL()) {
            const pgStart = Date.now();
            try {
                const postgres = await adapter.getPostgreSQL();
                await postgres.query('SELECT 1');
                const pgTime = Date.now() - pgStart;
                
                performanceTests.push({
                    database: 'postgresql',
                    test: 'simple_query',
                    duration_ms: pgTime,
                    status: 'success'
                });
            } catch (error) {
                performanceTests.push({
                    database: 'postgresql',
                    test: 'simple_query',
                    duration_ms: Date.now() - pgStart,
                    status: 'error',
                    error: error.message
                });
            }
        }

        const totalTime = Date.now() - startTime;

        res.json({
            status: 'completed',
            totalDuration: totalTime,
            tests: performanceTests,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Database analytics endpoint
 * GET /health/analytics
 */
router.get('/health/analytics', async (req, res) => {
    try {
        const { dbOperations } = require('../config/database-adapter');
        const analytics = await dbOperations.getCrossDbAnalytics();
        
        res.json({
            status: 'success',
            analytics,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Migration status endpoint
 * GET /health/migrations
 */
router.get('/health/migrations', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const migrations = await adapter.testMigrations();
        
        res.json({
            status: 'success',
            migrations,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Readiness probe (Kubernetes style)
 * GET /health/ready
 */
router.get('/health/ready', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        const health = await adapter.healthCheck();
        
        // Check if essential services are ready
        const isReady = health.status === 'healthy' || health.status === 'degraded';
        
        if (isReady) {
            res.status(200).json({
                status: 'ready',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(503).json({
                status: 'not_ready',
                reason: 'Database connections not healthy',
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        res.status(503).json({
            status: 'not_ready',
            reason: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Liveness probe (Kubernetes style)
 * GET /health/live
 */
router.get('/health/live', (req, res) => {
    // Simple liveness check - if the process is responding, it's alive
    res.status(200).json({
        status: 'alive',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

/**
 * Startup probe (Kubernetes style)
 * GET /health/startup
 */
router.get('/health/startup', async (req, res) => {
    try {
        const adapter = getDatabaseAdapter();
        
        // Check if the application has fully started
        if (adapter.isInitialized) {
            res.status(200).json({
                status: 'started',
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(503).json({
                status: 'starting',
                message: 'Application is still initializing',
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        res.status(503).json({
            status: 'startup_failed',
            reason: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Error handler middleware
 */
router.use((error, req, res, next) => {
    console.error('Health check error:', error);
    
    res.status(500).json({
        status: 'error',
        message: 'Health check failed',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;