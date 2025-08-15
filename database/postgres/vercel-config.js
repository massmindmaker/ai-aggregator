const { Pool } = require('pg');

/**
 * Vercel Postgres Configuration
 * Optimized for serverless functions with connection pooling
 */

class VercelPostgresConnection {
    constructor() {
        this.pool = null;
        this.isConnecting = false;
    }

    /**
     * Get connection string from environment variables
     */
    getConnectionString() {
        // Try different environment variable names
        return process.env.POSTGRES_URL || 
               process.env.DATABASE_URL || 
               process.env.POSTGRES_CONNECTION_STRING;
    }

    /**
     * Connection pool configuration optimized for serverless
     */
    getPoolConfig() {
        const connectionString = this.getConnectionString();
        
        if (!connectionString) {
            throw new Error('PostgreSQL connection string not found in environment variables');
        }

        return {
            connectionString,
            // Serverless optimization
            max: 5, // Maximum number of connections in the pool
            min: 0, // Minimum number of connections (0 for serverless)
            idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
            connectionTimeoutMillis: 10000, // Time to wait for connection
            // SSL configuration for production
            ssl: process.env.NODE_ENV === 'production' ? { 
                rejectUnauthorized: false 
            } : false,
            // Query timeout
            query_timeout: 60000,
            // Connection pool events
            log: (message) => {
                if (process.env.NODE_ENV !== 'production') {
                    console.log('PG Pool:', message);
                }
            }
        };
    }

    /**
     * Get or create connection pool
     */
    async getPool() {
        // Return existing pool if available
        if (this.pool && !this.pool.ended) {
            return this.pool;
        }

        // Prevent multiple pool creation attempts
        if (this.isConnecting) {
            while (this.isConnecting) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return this.pool;
        }

        try {
            this.isConnecting = true;
            
            console.log('Creating new PostgreSQL connection pool...');
            
            this.pool = new Pool(this.getPoolConfig());

            // Pool event handlers
            this.pool.on('connect', (client) => {
                console.log('New PostgreSQL client connected');
            });

            this.pool.on('error', (err, client) => {
                console.error('PostgreSQL pool error:', err);
            });

            this.pool.on('remove', (client) => {
                console.log('PostgreSQL client removed from pool');
            });

            // Test the connection
            const client = await this.pool.connect();
            await client.query('SELECT NOW()');
            client.release();

            console.log('✓ PostgreSQL connection pool created successfully');
            
            return this.pool;
        } catch (error) {
            console.error('✗ Failed to create PostgreSQL connection pool:', error);
            this.pool = null;
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Execute a query with automatic connection management
     */
    async query(text, params = []) {
        const pool = await this.getPool();
        const start = Date.now();
        
        try {
            const result = await pool.query(text, params);
            const duration = Date.now() - start;
            
            if (process.env.NODE_ENV !== 'production') {
                console.log('Query executed:', { text: text.substring(0, 100), duration, rows: result.rowCount });
            }
            
            return result;
        } catch (error) {
            console.error('Query error:', { text: text.substring(0, 100), error: error.message });
            throw error;
        }
    }

    /**
     * Get a client from the pool for transactions
     */
    async getClient() {
        const pool = await this.getPool();
        return await pool.connect();
    }

    /**
     * Execute a transaction
     */
    async transaction(callback) {
        const client = await this.getClient();
        
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Health check for PostgreSQL connection
     */
    async healthCheck() {
        try {
            const result = await this.query('SELECT NOW() as current_time, version() as version');
            
            return {
                status: 'connected',
                timestamp: result.rows[0].current_time,
                version: result.rows[0].version,
                poolSize: this.pool ? this.pool.totalCount : 0,
                idleConnections: this.pool ? this.pool.idleCount : 0,
                waitingClients: this.pool ? this.pool.waitingCount : 0
            };
        } catch (error) {
            return {
                status: 'error',
                message: error.message,
                code: error.code
            };
        }
    }

    /**
     * Get connection pool statistics
     */
    getPoolStats() {
        if (!this.pool) {
            return { status: 'no_pool' };
        }

        return {
            totalCount: this.pool.totalCount,
            idleCount: this.pool.idleCount,
            waitingCount: this.pool.waitingCount,
            maxConnections: this.pool.options.max,
            ended: this.pool.ended
        };
    }

    /**
     * Close all connections and end the pool
     */
    async disconnect() {
        if (this.pool && !this.pool.ended) {
            await this.pool.end();
            this.pool = null;
            console.log('PostgreSQL connection pool closed');
        }
    }

    /**
     * Graceful shutdown handler
     */
    async gracefulShutdown() {
        console.log('Initiating graceful PostgreSQL shutdown...');
        
        if (this.pool) {
            // Wait for active queries to complete (max 10 seconds)
            const shutdownTimeout = 10000;
            const startTime = Date.now();
            
            while (this.pool.totalCount > this.pool.idleCount && 
                   Date.now() - startTime < shutdownTimeout) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            await this.disconnect();
        }
        
        console.log('PostgreSQL graceful shutdown completed');
    }
}

// Singleton instance for connection reuse
let postgresConnection = null;

/**
 * Get shared PostgreSQL connection instance
 */
function getPostgresConnection() {
    if (!postgresConnection) {
        postgresConnection = new VercelPostgresConnection();
    }
    return postgresConnection;
}

/**
 * Utility functions for common database operations
 */
const dbUtils = {
    /**
     * Execute a simple query
     */
    async query(text, params = []) {
        const connection = getPostgresConnection();
        return await connection.query(text, params);
    },

    /**
     * Execute a transaction
     */
    async transaction(callback) {
        const connection = getPostgresConnection();
        return await connection.transaction(callback);
    },

    /**
     * Get database health status
     */
    async healthCheck() {
        const connection = getPostgresConnection();
        return await connection.healthCheck();
    },

    /**
     * Get connection pool statistics
     */
    getPoolStats() {
        const connection = getPostgresConnection();
        return connection.getPoolStats();
    },

    /**
     * Execute paginated query
     */
    async paginatedQuery(baseQuery, params = [], page = 1, limit = 20) {
        const offset = (page - 1) * limit;
        const paginatedQuery = `${baseQuery} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const paginatedParams = [...params, limit, offset];
        
        const connection = getPostgresConnection();
        const result = await connection.query(paginatedQuery, paginatedParams);
        
        // Get total count (for pagination info)
        const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) as count_query`;
        const countResult = await connection.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);
        
        return {
            data: result.rows,
            pagination: {
                page,
                limit,
                totalCount,
                totalPages: Math.ceil(totalCount / limit),
                hasNext: page * limit < totalCount,
                hasPrev: page > 1
            }
        };
    },

    /**
     * Bulk insert with conflict resolution
     */
    async bulkInsert(tableName, records, conflictColumns = []) {
        if (!records || records.length === 0) {
            return { insertedCount: 0 };
        }

        const connection = getPostgresConnection();
        const columns = Object.keys(records[0]);
        const placeholders = records.map((_, index) => {
            const rowPlaceholders = columns.map((_, colIndex) => 
                `$${index * columns.length + colIndex + 1}`
            );
            return `(${rowPlaceholders.join(', ')})`;
        }).join(', ');

        const values = records.flatMap(record => 
            columns.map(col => record[col])
        );

        let query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders}`;
        
        if (conflictColumns.length > 0) {
            query += ` ON CONFLICT (${conflictColumns.join(', ')}) DO NOTHING`;
        }

        const result = await connection.query(query, values);
        return { insertedCount: result.rowCount };
    }
};

// Graceful shutdown handler for serverless environments
process.on('SIGTERM', async () => {
    if (postgresConnection) {
        await postgresConnection.gracefulShutdown();
    }
});

process.on('SIGINT', async () => {
    if (postgresConnection) {
        await postgresConnection.gracefulShutdown();
    }
});

module.exports = {
    VercelPostgresConnection,
    getPostgresConnection,
    dbUtils
};