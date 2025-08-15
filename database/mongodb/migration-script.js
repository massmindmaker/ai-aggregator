const mongoose = require('mongoose');
const mongoAtlas = require('./atlas-config');
const { createIndexes } = require('./indexes');

/**
 * MongoDB Migration Script
 * Migrates data from local MongoDB to MongoDB Atlas
 */

// Source (local) connection
const sourceConfig = {
    uri: 'mongodb://Aexa:FH8238fdisdf4738fas9ada9sryeuirw@84.201.185.11/app?retryWrites=true&w=majority&authSource=admin',
    database: 'app'
};

// Collections to migrate
const collectionsToMigrate = [
    'users',
    'products',
    'contests',
    'contestdetails',
    'conteststatistics',
    'contestsubscribers',
    'contestdatas',
    'contesttimelines',
    'contestkeys',
    'orgs',
    'apischemas',
    'requests',
    'categories',
    'tags',
    'pricings',
    'userdetails',
    'userstatistics',
    'channels',
    'surveys',
    'links',
    'whitelists',
    'payments'
];

class MongoMigration {
    constructor() {
        this.sourceConnection = null;
        this.targetConnection = null;
        this.migrationStats = {};
    }

    /**
     * Connect to source MongoDB
     */
    async connectSource() {
        try {
            console.log('Connecting to source MongoDB...');
            this.sourceConnection = await mongoose.createConnection(sourceConfig.uri, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
                maxPoolSize: 5
            });
            console.log('✓ Connected to source MongoDB');
        } catch (error) {
            console.error('✗ Failed to connect to source MongoDB:', error);
            throw error;
        }
    }

    /**
     * Connect to target MongoDB Atlas
     */
    async connectTarget() {
        try {
            console.log('Connecting to target MongoDB Atlas...');
            this.targetConnection = await mongoAtlas.connect();
            console.log('✓ Connected to target MongoDB Atlas');
        } catch (error) {
            console.error('✗ Failed to connect to target MongoDB Atlas:', error);
            throw error;
        }
    }

    /**
     * Get collection count
     */
    async getCollectionCount(connection, collectionName) {
        try {
            const collection = connection.db.collection(collectionName);
            return await collection.countDocuments();
        } catch (error) {
            return 0;
        }
    }

    /**
     * Migrate a single collection with batch processing
     */
    async migrateCollection(collectionName, batchSize = 1000) {
        try {
            console.log(`\n📦 Migrating collection: ${collectionName}`);
            
            const sourceCollection = this.sourceConnection.db.collection(collectionName);
            const targetCollection = mongoose.connection.db.collection(collectionName);

            // Get total count
            const totalCount = await sourceCollection.countDocuments();
            console.log(`📊 Total documents: ${totalCount}`);

            if (totalCount === 0) {
                console.log(`⚠ Collection ${collectionName} is empty, skipping...`);
                this.migrationStats[collectionName] = {
                    total: 0,
                    migrated: 0,
                    errors: 0
                };
                return;
            }

            // Check if target collection already has data
            const existingCount = await targetCollection.countDocuments();
            if (existingCount > 0) {
                console.log(`⚠ Target collection ${collectionName} already has ${existingCount} documents`);
                const shouldContinue = process.env.FORCE_MIGRATION === 'true';
                if (!shouldContinue) {
                    console.log(`⏭ Skipping ${collectionName} migration (use FORCE_MIGRATION=true to override)`);
                    return;
                }
                console.log(`🗑 Clearing target collection...`);
                await targetCollection.deleteMany({});
            }

            let migratedCount = 0;
            let errorCount = 0;
            let skip = 0;

            // Process in batches
            while (skip < totalCount) {
                try {
                    const batch = await sourceCollection
                        .find({})
                        .skip(skip)
                        .limit(batchSize)
                        .toArray();

                    if (batch.length === 0) break;

                    // Insert batch to target
                    if (batch.length > 0) {
                        await targetCollection.insertMany(batch, { ordered: false });
                        migratedCount += batch.length;
                    }

                    skip += batchSize;
                    
                    // Progress indicator
                    const progress = Math.round((skip / totalCount) * 100);
                    process.stdout.write(`\r🔄 Progress: ${progress}% (${migratedCount}/${totalCount})`);

                } catch (error) {
                    console.error(`\n✗ Batch error:`, error.message);
                    errorCount++;
                    
                    // Try individual inserts for failed batch
                    const batch = await sourceCollection
                        .find({})
                        .skip(skip)
                        .limit(batchSize)
                        .toArray();

                    for (const doc of batch) {
                        try {
                            await targetCollection.insertOne(doc);
                            migratedCount++;
                        } catch (insertError) {
                            console.error(`\n✗ Document insert error:`, insertError.message);
                            errorCount++;
                        }
                    }
                    
                    skip += batchSize;
                }
            }

            console.log(`\n✓ Migration completed for ${collectionName}`);
            console.log(`📊 Results: ${migratedCount} migrated, ${errorCount} errors`);

            this.migrationStats[collectionName] = {
                total: totalCount,
                migrated: migratedCount,
                errors: errorCount
            };

        } catch (error) {
            console.error(`\n✗ Failed to migrate collection ${collectionName}:`, error);
            this.migrationStats[collectionName] = {
                total: 0,
                migrated: 0,
                errors: 1,
                error: error.message
            };
        }
    }

    /**
     * Verify migration results
     */
    async verifyMigration() {
        console.log('\n🔍 Verifying migration...');
        
        for (const collectionName of collectionsToMigrate) {
            try {
                const sourceCount = await this.getCollectionCount(this.sourceConnection, collectionName);
                const targetCount = await this.getCollectionCount(mongoose.connection, collectionName);
                
                const status = sourceCount === targetCount ? '✓' : '⚠';
                console.log(`${status} ${collectionName}: source=${sourceCount}, target=${targetCount}`);
                
                if (sourceCount !== targetCount) {
                    console.log(`  ⚠ Count mismatch detected!`);
                }
            } catch (error) {
                console.error(`✗ Verification failed for ${collectionName}:`, error.message);
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
        
        for (const [collection, stats] of Object.entries(this.migrationStats)) {
            const { total, migrated, errors } = stats;
            totalMigrated += migrated;
            totalErrors += errors;
            
            const status = errors > 0 ? '⚠' : '✓';
            console.log(`${status} ${collection}: ${migrated}/${total} (${errors} errors)`);
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
            console.log('🚀 Starting MongoDB migration to Atlas...');
            console.log('==========================================');

            // Connect to both databases
            await this.connectSource();
            await this.connectTarget();

            // Migrate each collection
            for (const collectionName of collectionsToMigrate) {
                await this.migrateCollection(collectionName);
            }

            // Create indexes
            console.log('\n🔧 Creating indexes...');
            await createIndexes();

            // Verify migration
            await this.verifyMigration();

            // Print summary
            this.printSummary();

            console.log('\n🎉 Migration completed successfully!');

        } catch (error) {
            console.error('\n💥 Migration failed:', error);
            throw error;
        } finally {
            // Close connections
            if (this.sourceConnection) {
                await this.sourceConnection.close();
                console.log('🔌 Source connection closed');
            }
            
            if (this.targetConnection) {
                await mongoAtlas.disconnect();
                console.log('🔌 Target connection closed');
            }
        }
    }

    /**
     * Rollback migration (delete all data from Atlas)
     */
    async rollbackMigration() {
        try {
            console.log('🔄 Rolling back migration...');
            
            await this.connectTarget();
            
            for (const collectionName of collectionsToMigrate) {
                try {
                    const collection = mongoose.connection.db.collection(collectionName);
                    const result = await collection.deleteMany({});
                    console.log(`✓ Cleared ${collectionName}: ${result.deletedCount} documents`);
                } catch (error) {
                    console.error(`✗ Failed to clear ${collectionName}:`, error.message);
                }
            }
            
            console.log('✓ Rollback completed');
            
        } catch (error) {
            console.error('✗ Rollback failed:', error);
            throw error;
        } finally {
            if (this.targetConnection) {
                await mongoAtlas.disconnect();
            }
        }
    }
}

// CLI interface
async function main() {
    const migration = new MongoMigration();
    const command = process.argv[2];

    try {
        switch (command) {
            case 'migrate':
                await migration.runMigration();
                break;
            case 'rollback':
                await migration.rollbackMigration();
                break;
            case 'verify':
                await migration.connectSource();
                await migration.connectTarget();
                await migration.verifyMigration();
                break;
            default:
                console.log('Usage:');
                console.log('  node migration-script.js migrate   - Run migration');
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

module.exports = MongoMigration;