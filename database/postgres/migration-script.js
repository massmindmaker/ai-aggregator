const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

/**
 * PostgreSQL Migration Script for Vercel Postgres
 * Migrates data from local PostgreSQL to Vercel Postgres
 */

class PostgresMigration {
    constructor() {
        this.sourcePool = null;
        this.targetPool = null;
        this.migrationStats = {};
    }

    /**
     * Initialize database connections
     */
    async initializeConnections() {
        try {
            // Source (local) PostgreSQL connection
            this.sourcePool = new Pool({
                user: "postgres",
                password: '333777',
                host: "localhost",
                port: 5432,
                database: 'apihubdb',
                max: 10,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000,
            });

            // Target (Vercel) PostgreSQL connection
            this.targetPool = new Pool({
                connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 10,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000,
            });

            // Test connections
            await this.sourcePool.query('SELECT NOW()');
            await this.targetPool.query('SELECT NOW()');

            console.log('✓ Database connections established');
        } catch (error) {
            console.error('✗ Failed to establish database connections:', error);
            throw error;
        }
    }

    /**
     * Create schema on target database
     */
    async createSchema() {
        try {
            console.log('📋 Creating schema on target database...');
            
            const schemaPath = path.join(__dirname, 'vercel-schema.sql');
            const schemaSQL = await fs.readFile(schemaPath, 'utf8');
            
            // Split by statements and execute one by one
            const statements = schemaSQL
                .split(';')
                .map(stmt => stmt.trim())
                .filter(stmt => stmt.length > 0);

            for (const statement of statements) {
                try {
                    await this.targetPool.query(statement);
                } catch (error) {
                    // Ignore "already exists" errors
                    if (!error.message.includes('already exists')) {
                        console.warn('⚠ Schema statement warning:', error.message);
                    }
                }
            }

            console.log('✓ Schema created successfully');
        } catch (error) {
            console.error('✗ Failed to create schema:', error);
            throw error;
        }
    }

    /**
     * Get table count
     */
    async getTableCount(pool, tableName) {
        try {
            const result = await pool.query(`SELECT COUNT(*) FROM ${tableName}`);
            return parseInt(result.rows[0].count);
        } catch (error) {
            return 0;
        }
    }

    /**
     * Get table columns
     */
    async getTableColumns(pool, tableName) {
        try {
            const result = await pool.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = $1 
                ORDER BY ordinal_position
            `, [tableName]);
            return result.rows;
        } catch (error) {
            console.error(`Failed to get columns for ${tableName}:`, error);
            return [];
        }
    }

    /**
     * Migrate a single table
     */
    async migrateTable(tableName, batchSize = 1000) {
        try {
            console.log(`\n📦 Migrating table: ${tableName}`);

            // Check if table exists in source
            const sourceCount = await this.getTableCount(this.sourcePool, tableName);
            console.log(`📊 Source records: ${sourceCount}`);

            if (sourceCount === 0) {
                console.log(`⚠ Table ${tableName} is empty, skipping...`);
                this.migrationStats[tableName] = {
                    total: 0,
                    migrated: 0,
                    errors: 0
                };
                return;
            }

            // Check target table
            const targetCount = await this.getTableCount(this.targetPool, tableName);
            if (targetCount > 0) {
                console.log(`⚠ Target table ${tableName} already has ${targetCount} records`);
                const shouldContinue = process.env.FORCE_MIGRATION === 'true';
                if (!shouldContinue) {
                    console.log(`⏭ Skipping ${tableName} migration (use FORCE_MIGRATION=true to override)`);
                    return;
                }
                console.log(`🗑 Clearing target table...`);
                await this.targetPool.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE`);
            }

            // Get table columns
            const sourceColumns = await this.getTableColumns(this.sourcePool, tableName);
            const targetColumns = await this.getTableColumns(this.targetPool, tableName);
            
            // Find common columns
            const commonColumns = sourceColumns
                .filter(sourceCol => 
                    targetColumns.some(targetCol => targetCol.column_name === sourceCol.column_name)
                )
                .map(col => col.column_name);

            if (commonColumns.length === 0) {
                console.log(`⚠ No common columns found for ${tableName}`);
                return;
            }

            console.log(`📋 Migrating columns: ${commonColumns.join(', ')}`);

            let migratedCount = 0;
            let errorCount = 0;
            let offset = 0;

            // Process in batches
            while (offset < sourceCount) {
                try {
                    // Get batch from source
                    const selectQuery = `
                        SELECT ${commonColumns.join(', ')} 
                        FROM ${tableName} 
                        ORDER BY id 
                        LIMIT $1 OFFSET $2
                    `;
                    
                    const sourceResult = await this.sourcePool.query(selectQuery, [batchSize, offset]);
                    const batch = sourceResult.rows;

                    if (batch.length === 0) break;

                    // Insert batch to target
                    if (batch.length > 0) {
                        const placeholders = batch.map((_, index) => {
                            const rowPlaceholders = commonColumns.map((_, colIndex) => 
                                `$${index * commonColumns.length + colIndex + 1}`
                            );
                            return `(${rowPlaceholders.join(', ')})`;
                        }).join(', ');

                        const insertQuery = `
                            INSERT INTO ${tableName} (${commonColumns.join(', ')}) 
                            VALUES ${placeholders}
                            ON CONFLICT (id) DO NOTHING
                        `;

                        const values = batch.flatMap(row => 
                            commonColumns.map(col => row[col])
                        );

                        await this.targetPool.query(insertQuery, values);
                        migratedCount += batch.length;
                    }

                    offset += batchSize;
                    
                    // Progress indicator
                    const progress = Math.round((offset / sourceCount) * 100);
                    process.stdout.write(`\r🔄 Progress: ${progress}% (${migratedCount}/${sourceCount})`);

                } catch (error) {
                    console.error(`\n✗ Batch error:`, error.message);
                    errorCount++;
                    offset += batchSize;
                }
            }

            console.log(`\n✓ Migration completed for ${tableName}`);
            console.log(`📊 Results: ${migratedCount} migrated, ${errorCount} errors`);

            this.migrationStats[tableName] = {
                total: sourceCount,
                migrated: migratedCount,
                errors: errorCount
            };

        } catch (error) {
            console.error(`\n✗ Failed to migrate table ${tableName}:`, error);
            this.migrationStats[tableName] = {
                total: 0,
                migrated: 0,
                errors: 1,
                error: error.message
            };
        }
    }

    /**
     * Migrate data transformation for enhanced schema
     */
    async migrateWithTransformation() {
        try {
            console.log('\n🔄 Migrating with data transformation...');

            // Migrate person table (add new fields with defaults)
            await this.migratePersonWithDefaults();
            
            // Migrate post table (add new fields with defaults)
            await this.migratePostWithDefaults();
            
            // Migrate request table with enhanced fields
            await this.migrateRequestWithEnhancement();

        } catch (error) {
            console.error('✗ Migration with transformation failed:', error);
            throw error;
        }
    }

    /**
     * Migrate person table with default values for new fields
     */
    async migratePersonWithDefaults() {
        try {
            console.log('\n📦 Migrating person table with defaults...');
            
            const sourceResult = await this.sourcePool.query('SELECT * FROM person ORDER BY id');
            const records = sourceResult.rows;

            if (records.length === 0) {
                console.log('⚠ No person records to migrate');
                return;
            }

            for (const record of records) {
                const insertQuery = `
                    INSERT INTO person (id, name, surname, email, created_at, updated_at, is_active)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        surname = EXCLUDED.surname,
                        email = EXCLUDED.email,
                        updated_at = NOW()
                `;

                await this.targetPool.query(insertQuery, [
                    record.id,
                    record.name,
                    record.surname,
                    record.email || `user${record.id}@example.com`,
                    new Date(),
                    new Date(),
                    true
                ]);
            }

            console.log(`✓ Migrated ${records.length} person records`);
        } catch (error) {
            console.error('✗ Failed to migrate person table:', error);
            throw error;
        }
    }

    /**
     * Migrate post table with default values
     */
    async migratePostWithDefaults() {
        try {
            console.log('\n📦 Migrating post table with defaults...');
            
            const sourceResult = await this.sourcePool.query('SELECT * FROM post ORDER BY id');
            const records = sourceResult.rows;

            if (records.length === 0) {
                console.log('⚠ No post records to migrate');
                return;
            }

            for (const record of records) {
                const insertQuery = `
                    INSERT INTO post (id, title, content, user_id, created_at, updated_at, published)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (id) DO UPDATE SET
                        title = EXCLUDED.title,
                        content = EXCLUDED.content,
                        user_id = EXCLUDED.user_id,
                        updated_at = NOW()
                `;

                await this.targetPool.query(insertQuery, [
                    record.id,
                    record.title,
                    record.content,
                    record.user_id,
                    new Date(),
                    new Date(),
                    false
                ]);
            }

            console.log(`✓ Migrated ${records.length} post records`);
        } catch (error) {
            console.error('✗ Failed to migrate post table:', error);
            throw error;
        }
    }

    /**
     * Migrate request table with enhanced fields
     */
    async migrateRequestWithEnhancement() {
        try {
            console.log('\n📦 Migrating request table with enhancements...');
            
            const sourceResult = await this.sourcePool.query(`
                SELECT * FROM request 
                ORDER BY id 
                LIMIT 10000
            `);
            const records = sourceResult.rows;

            if (records.length === 0) {
                console.log('⚠ No request records to migrate');
                return;
            }

            const batchSize = 100;
            let processed = 0;

            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);
                
                for (const record of batch) {
                    const insertQuery = `
                        INSERT INTO request (
                            id, uid, date, product_sid, endpoint_sid, appkey, latency,
                            response_status, response_size, response_type, request_size, request_type,
                            credits_used, plan_type
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                        ON CONFLICT (id) DO NOTHING
                    `;

                    await this.targetPool.query(insertQuery, [
                        record.id,
                        record.uid,
                        record.date,
                        record.product_sid,
                        record.endpoint_sid,
                        record.appkey,
                        record.latency,
                        record.response_status,
                        record.response_size || 0,
                        record.response_type,
                        record.request_size || 0,
                        record.request_type,
                        1, // default credits_used
                        'free' // default plan_type
                    ]);
                }

                processed += batch.length;
                const progress = Math.round((processed / records.length) * 100);
                process.stdout.write(`\r🔄 Progress: ${progress}% (${processed}/${records.length})`);
            }

            console.log(`\n✓ Migrated ${records.length} request records`);
        } catch (error) {
            console.error('\n✗ Failed to migrate request table:', error);
            throw error;
        }
    }

    /**
     * Create sample API products and endpoints
     */
    async createSampleData() {
        try {
            console.log('\n📦 Creating sample API products and endpoints...');

            // Sample API products
            const products = [
                { sid: 1001, name: 'AI Text Analysis API', description: 'Comprehensive text analysis and NLP services', category: 'nlp' },
                { sid: 1002, name: 'Image Recognition API', description: 'Advanced image classification and object detection', category: 'computer-vision' },
                { sid: 1003, name: 'Data Analytics API', description: 'Statistical analysis and data processing tools', category: 'analytics' }
            ];

            for (const product of products) {
                await this.targetPool.query(`
                    INSERT INTO api_products (sid, name, description, category, base_url, status)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (sid) DO NOTHING
                `, [product.sid, product.name, product.description, product.category, 'https://api.example.com', 'active']);
            }

            // Sample endpoints
            const endpoints = [
                { sid: 2001, product_sid: 1001, path: '/analyze/sentiment', method: 'POST', name: 'Sentiment Analysis' },
                { sid: 2002, product_sid: 1001, path: '/analyze/entities', method: 'POST', name: 'Entity Extraction' },
                { sid: 2003, product_sid: 1002, path: '/classify/image', method: 'POST', name: 'Image Classification' },
                { sid: 2004, product_sid: 1003, path: '/stats/summary', method: 'GET', name: 'Statistical Summary' }
            ];

            for (const endpoint of endpoints) {
                await this.targetPool.query(`
                    INSERT INTO api_endpoints (sid, product_sid, path, method, name, rate_limit)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (sid) DO NOTHING
                `, [endpoint.sid, endpoint.product_sid, endpoint.path, endpoint.method, endpoint.name, 1000]);
            }

            console.log('✓ Sample data created');
        } catch (error) {
            console.error('✗ Failed to create sample data:', error);
            throw error;
        }
    }

    /**
     * Verify migration results
     */
    async verifyMigration() {
        console.log('\n🔍 Verifying migration...');
        
        const tables = ['person', 'post', 'request'];
        
        for (const tableName of tables) {
            try {
                const sourceCount = await this.getTableCount(this.sourcePool, tableName);
                const targetCount = await this.getTableCount(this.targetPool, tableName);
                
                const status = sourceCount === targetCount ? '✓' : '⚠';
                console.log(`${status} ${tableName}: source=${sourceCount}, target=${targetCount}`);
                
                if (sourceCount !== targetCount && sourceCount > 0) {
                    console.log(`  ⚠ Count mismatch detected!`);
                }
            } catch (error) {
                console.error(`✗ Verification failed for ${tableName}:`, error.message);
            }
        }
    }

    /**
     * Print migration summary
     */
    printSummary() {
        console.log('\n📋 Migration Summary:');
        console.log('=====================================');
        
        let totalMigrated = 0;
        let totalErrors = 0;
        
        for (const [table, stats] of Object.entries(this.migrationStats)) {
            const { total, migrated, errors } = stats;
            totalMigrated += migrated;
            totalErrors += errors;
            
            const status = errors > 0 ? '⚠' : '✓';
            console.log(`${status} ${table}: ${migrated}/${total} (${errors} errors)`);
        }
        
        console.log('=====================================');
        console.log(`📊 Total migrated: ${totalMigrated}`);
        console.log(`❌ Total errors: ${totalErrors}`);
        console.log('=====================================');
    }

    /**
     * Run complete migration
     */
    async runMigration() {
        try {
            console.log('🚀 Starting PostgreSQL migration to Vercel...');
            console.log('==============================================');

            // Initialize connections
            await this.initializeConnections();

            // Create schema
            await this.createSchema();

            // Migrate data with transformation
            await this.migrateWithTransformation();

            // Create sample data
            await this.createSampleData();

            // Verify migration
            await this.verifyMigration();

            // Print summary
            this.printSummary();

            console.log('\n🎉 PostgreSQL migration completed successfully!');

        } catch (error) {
            console.error('\n💥 Migration failed:', error);
            throw error;
        } finally {
            // Close connections
            if (this.sourcePool) {
                await this.sourcePool.end();
                console.log('🔌 Source connection closed');
            }
            
            if (this.targetPool) {
                await this.targetPool.end();
                console.log('🔌 Target connection closed');
            }
        }
    }

    /**
     * Rollback migration
     */
    async rollbackMigration() {
        try {
            console.log('🔄 Rolling back PostgreSQL migration...');
            
            await this.initializeConnections();
            
            const tables = ['error_logs', 'user_usage_stats', 'hourly_request_stats', 'daily_request_stats', 
                          'api_keys', 'api_endpoints', 'api_products', 'request', 'post', 'person'];
            
            for (const table of tables) {
                try {
                    await this.targetPool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
                    console.log(`✓ Cleared ${table}`);
                } catch (error) {
                    console.error(`✗ Failed to clear ${table}:`, error.message);
                }
            }
            
            console.log('✓ Rollback completed');
            
        } catch (error) {
            console.error('✗ Rollback failed:', error);
            throw error;
        } finally {
            if (this.targetPool) {
                await this.targetPool.end();
            }
        }
    }
}

// CLI interface
async function main() {
    const migration = new PostgresMigration();
    const command = process.argv[2];

    try {
        switch (command) {
            case 'migrate':
                await migration.runMigration();
                break;
            case 'rollback':
                await migration.rollbackMigration();
                break;
            case 'schema':
                await migration.initializeConnections();
                await migration.createSchema();
                break;
            case 'verify':
                await migration.initializeConnections();
                await migration.verifyMigration();
                break;
            default:
                console.log('Usage:');
                console.log('  node migration-script.js migrate   - Run full migration');
                console.log('  node migration-script.js schema    - Create schema only');
                console.log('  node migration-script.js rollback  - Rollback migration');
                console.log('  node migration-script.js verify    - Verify migration');
                process.exit(1);
        }
    } catch (error) {
        console.error('Migration script error:', error);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = PostgresMigration;