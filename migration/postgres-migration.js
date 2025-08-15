#!/usr/bin/env node

/**
 * PostgreSQL Migration Script for AI Aggregator Hub to Vercel Postgres
 * 
 * This script migrates data from local PostgreSQL to Vercel Postgres
 * Run with: node postgres-migration.js
 */

const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Configuration
const config = {
    local: {
        user: process.env.LOCAL_PG_USER || "postgres",
        password: process.env.LOCAL_PG_PASSWORD || '333777',
        host: process.env.LOCAL_PG_HOST || "localhost",
        port: parseInt(process.env.LOCAL_PG_PORT) || 5432,
        database: process.env.LOCAL_PG_DATABASE || 'apihubdb',
        ssl: false
    },
    vercel: {
        connectionString: process.env.POSTGRES_URL || process.env.VERCEL_POSTGRES_URL,
        ssl: {
            rejectUnauthorized: false
        }
    }
};

// Tables to migrate
const tables = ['person', 'post', 'request'];

class PostgresMigrator {
    constructor() {
        this.localPool = null;
        this.vercelPool = null;
        this.stats = {
            migrated: 0,
            failed: 0,
            total: 0,
            tables: {}
        };
    }

    async connect() {
        console.log('🔌 Connecting to databases...');
        
        try {
            // Connect to local PostgreSQL
            this.localPool = new Pool(config.local);
            await this.localPool.query('SELECT NOW()');
            console.log('✅ Connected to local PostgreSQL');

            // Connect to Vercel Postgres
            if (!config.vercel.connectionString) {
                throw new Error('POSTGRES_URL environment variable is required for Vercel Postgres');
            }
            
            this.vercelPool = new Pool({
                connectionString: config.vercel.connectionString,
                ssl: config.vercel.ssl
            });
            await this.vercelPool.query('SELECT NOW()');
            console.log('✅ Connected to Vercel Postgres');
            
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            throw error;
        }
    }

    async setupSchema() {
        console.log('\n🏗️  Setting up schema on Vercel Postgres...');
        
        try {
            const schemaPath = path.join(__dirname, 'postgres-schema.sql');
            const schema = await fs.readFile(schemaPath, 'utf8');
            
            // Execute schema creation
            await this.vercelPool.query(schema);
            console.log('✅ Schema setup completed');
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('⚠️  Schema file not found, skipping schema setup...');
            } else {
                console.error('❌ Schema setup failed:', error.message);
                throw error;
            }
        }
    }

    async getTableStructure(tableName) {
        try {
            const result = await this.localPool.query(`
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_name = $1
                ORDER BY ordinal_position
            `, [tableName]);
            
            return result.rows;
        } catch (error) {
            console.error(`❌ Error getting structure for ${tableName}:`, error.message);
            return [];
        }
    }

    async migrateTable(tableName) {
        console.log(`\n📦 Migrating table: ${tableName}`);
        
        try {
            // Check if table exists in local database
            const tableExists = await this.localPool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = $1
                )
            `, [tableName]);

            if (!tableExists.rows[0].exists) {
                console.log(`⚠️  Table '${tableName}' not found in local database, skipping...`);
                return;
            }

            // Get table structure
            const structure = await this.getTableStructure(tableName);
            console.log(`📊 Table structure: ${structure.length} columns`);

            // Get total count
            const countResult = await this.localPool.query(`SELECT COUNT(*) FROM ${tableName}`);
            const totalRows = parseInt(countResult.rows[0].count);
            
            if (totalRows === 0) {
                console.log(`📭 Table '${tableName}' is empty, skipping...`);
                this.stats.tables[tableName] = { migrated: 0, total: 0 };
                return;
            }

            console.log(`📊 Found ${totalRows} rows in ${tableName}`);

            // Clear existing data in Vercel (optional)
            try {
                const existingResult = await this.vercelPool.query(`SELECT COUNT(*) FROM ${tableName}`);
                const existingRows = parseInt(existingResult.rows[0].count);
                
                if (existingRows > 0) {
                    console.log(`🗑️  Clearing ${existingRows} existing rows in Vercel...`);
                    await this.vercelPool.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE`);
                }
            } catch (error) {
                console.log(`⚠️  Could not clear existing data: ${error.message}`);
            }

            // Migrate in batches
            const batchSize = 1000;
            let migratedCount = 0;
            let offset = 0;

            while (offset < totalRows) {
                try {
                    // Fetch batch from local
                    const localResult = await this.localPool.query(`
                        SELECT * FROM ${tableName} 
                        ORDER BY id 
                        LIMIT ${batchSize} OFFSET ${offset}
                    `);

                    if (localResult.rows.length === 0) {
                        break;
                    }

                    // Prepare insert query
                    const columns = Object.keys(localResult.rows[0]);
                    const placeholders = localResult.rows.map((_, rowIndex) => {
                        return `(${columns.map((_, colIndex) => 
                            `$${rowIndex * columns.length + colIndex + 1}`
                        ).join(', ')})`;
                    }).join(', ');

                    const values = localResult.rows.flatMap(row => columns.map(col => row[col]));
                    
                    const insertQuery = `
                        INSERT INTO ${tableName} (${columns.join(', ')})
                        VALUES ${placeholders}
                        ON CONFLICT (id) DO NOTHING
                    `;

                    // Insert into Vercel
                    const insertResult = await this.vercelPool.query(insertQuery, values);
                    
                    migratedCount += localResult.rows.length;
                    offset += batchSize;

                    console.log(`✅ Migrated ${migratedCount}/${totalRows} rows`);

                } catch (batchError) {
                    console.error(`❌ Error in batch starting at offset ${offset}:`, batchError.message);
                    
                    // Try individual inserts for this batch
                    const localResult = await this.localPool.query(`
                        SELECT * FROM ${tableName} 
                        ORDER BY id 
                        LIMIT ${batchSize} OFFSET ${offset}
                    `);

                    for (const row of localResult.rows) {
                        try {
                            const columns = Object.keys(row);
                            const placeholders = columns.map((_, index) => `$${index + 1}`);
                            const values = columns.map(col => row[col]);

                            const singleInsertQuery = `
                                INSERT INTO ${tableName} (${columns.join(', ')})
                                VALUES (${placeholders.join(', ')})
                                ON CONFLICT (id) DO NOTHING
                            `;

                            await this.vercelPool.query(singleInsertQuery, values);
                            migratedCount++;
                        } catch (rowError) {
                            console.error(`❌ Error inserting row ${row.id}:`, rowError.message);
                        }
                    }

                    offset += batchSize;
                    console.log(`✅ Processed individual inserts: ${migratedCount}/${totalRows} rows`);
                }
            }

            // Update sequence if exists
            try {
                await this.vercelPool.query(`
                    SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), 
                           (SELECT MAX(id) FROM ${tableName}))
                `);
            } catch (seqError) {
                console.log(`⚠️  Could not update sequence for ${tableName}: ${seqError.message}`);
            }

            this.stats.tables[tableName] = { migrated: migratedCount, total: totalRows };
            this.stats.migrated += migratedCount;
            this.stats.total += totalRows;

            console.log(`✅ Completed migration of ${tableName}: ${migratedCount}/${totalRows} rows`);

        } catch (error) {
            console.error(`❌ Error migrating ${tableName}:`, error.message);
            this.stats.tables[tableName] = { migrated: 0, total: 0, error: error.message };
            this.stats.failed++;
        }
    }

    async validateMigration() {
        console.log('\n🔍 Validating migration...');
        
        try {
            for (const table of tables) {
                try {
                    const localResult = await this.localPool.query(`SELECT COUNT(*) FROM ${table}`);
                    const vercelResult = await this.vercelPool.query(`SELECT COUNT(*) FROM ${table}`);
                    
                    const localCount = parseInt(localResult.rows[0].count);
                    const vercelCount = parseInt(vercelResult.rows[0].count);
                    
                    if (localCount !== vercelCount) {
                        console.log(`⚠️  Mismatch in ${table}: local=${localCount}, vercel=${vercelCount}`);
                    } else if (localCount > 0) {
                        console.log(`✅ ${table}: ${vercelCount} rows`);
                    }
                } catch (error) {
                    console.log(`❌ Validation failed for ${table}: ${error.message}`);
                }
            }
        } catch (error) {
            console.error('❌ Validation error:', error.message);
        }
    }

    async createAnalyticsViews() {
        console.log('\n📊 Creating analytics views...');
        
        try {
            // API request analytics view
            await this.vercelPool.query(`
                CREATE OR REPLACE VIEW request_analytics AS
                SELECT 
                    DATE(date) as request_date,
                    product_sid,
                    endpoint_sid,
                    COUNT(*) as total_requests,
                    COUNT(*) FILTER (WHERE response_status < 400) as successful_requests,
                    COUNT(*) FILTER (WHERE response_status >= 400) as failed_requests,
                    AVG(latency) as avg_latency,
                    MAX(latency) as max_latency,
                    MIN(latency) as min_latency,
                    COUNT(DISTINCT appkey) as unique_apps
                FROM request
                GROUP BY DATE(date), product_sid, endpoint_sid
                ORDER BY request_date DESC;
            `);

            // Daily metrics view
            await this.vercelPool.query(`
                CREATE OR REPLACE VIEW daily_metrics AS
                SELECT 
                    DATE(date) as metric_date,
                    COUNT(*) as total_requests,
                    COUNT(DISTINCT appkey) as unique_apps,
                    COUNT(DISTINCT product_sid) as active_apis,
                    AVG(latency) as avg_latency,
                    COUNT(*) FILTER (WHERE response_status >= 500) as server_errors,
                    COUNT(*) FILTER (WHERE response_status >= 400 AND response_status < 500) as client_errors
                FROM request
                GROUP BY DATE(date)
                ORDER BY metric_date DESC;
            `);

            console.log('✅ Analytics views created');
        } catch (error) {
            console.error('❌ Error creating analytics views:', error.message);
        }
    }

    async disconnect() {
        try {
            if (this.localPool) {
                await this.localPool.end();
                console.log('🔌 Disconnected from local PostgreSQL');
            }
            if (this.vercelPool) {
                await this.vercelPool.end();
                console.log('🔌 Disconnected from Vercel Postgres');
            }
        } catch (error) {
            console.error('❌ Error disconnecting:', error.message);
        }
    }

    printStats() {
        console.log('\n📈 Migration Statistics:');
        console.log('========================');
        console.log(`Total rows: ${this.stats.total}`);
        console.log(`Successfully migrated: ${this.stats.migrated}`);
        console.log(`Failed tables: ${this.stats.failed}`);
        console.log('\nPer table:');
        
        Object.entries(this.stats.tables).forEach(([name, stats]) => {
            if (stats.error) {
                console.log(`❌ ${name}: ERROR - ${stats.error}`);
            } else {
                console.log(`✅ ${name}: ${stats.migrated}/${stats.total} rows`);
            }
        });
    }

    async migrate() {
        try {
            console.log('🚀 Starting PostgreSQL migration to Vercel Postgres...\n');
            
            await this.connect();
            
            // Setup schema first
            await this.setupSchema();
            
            // Migrate each table
            for (const table of tables) {
                await this.migrateTable(table);
            }
            
            // Create analytics views
            await this.createAnalyticsViews();
            
            // Validate migration
            await this.validateMigration();
            
            this.printStats();
            
            console.log('\n🎉 PostgreSQL migration completed successfully!');
            
        } catch (error) {
            console.error('\n❌ Migration failed:', error.message);
            process.exit(1);
        } finally {
            await this.disconnect();
        }
    }
}

// Run migration if called directly
if (require.main === module) {
    const migrator = new PostgresMigrator();
    migrator.migrate().catch(console.error);
}

module.exports = PostgresMigrator;