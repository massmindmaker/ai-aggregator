#!/usr/bin/env node

/**
 * MongoDB Migration Script for AI Aggregator to MongoDB Atlas
 * 
 * This script migrates data from local MongoDB to MongoDB Atlas
 * Run with: node mongodb-migration.js
 */

const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Configuration
const config = {
    local: {
        uri: process.env.LOCAL_MONGO_URI || 'mongodb://Aexa:FH8238fdisdf4738fas9ada9sryeuirw@84.201.185.11/app?retryWrites=true&w=majority&authSource=admin',
        database: 'app'
    },
    atlas: {
        uri: process.env.ATLAS_MONGO_URI || 'mongodb+srv://username:password@cluster.mongodb.net/aiag?retryWrites=true&w=majority',
        database: 'aiag'
    }
};

// Collections to migrate
const collections = [
    'users',
    'products',
    'contests',
    'contestdetails',
    'conteststatistics',
    'contestkeys',
    'contestdatas',
    'contestsubscribers',
    'contesttimelines',
    'orgs',
    'orgdetails',
    'orgstatistics',
    'orgposts',
    'orgfeeds',
    'apis',
    'apidetails',
    'apistatistics',
    'apiendpoints',
    'apiplans',
    'apisubscribers',
    'requests',
    'categoryitems',
    'channels',
    'pricings',
    'apiplanss',
    'appparameters',
    'apps',
    'pays',
    'links',
    'userdetails',
    'userstatistics',
    'userverifys',
    'whitelists',
    'surveys',
    'tests',
    'tagschemas'
];

class MongoMigrator {
    constructor() {
        this.localClient = null;
        this.atlasClient = null;
        this.stats = {
            migrated: 0,
            failed: 0,
            total: 0,
            collections: {}
        };
    }

    async connect() {
        console.log('🔌 Connecting to databases...');
        
        try {
            // Connect to local MongoDB
            this.localClient = new MongoClient(config.local.uri, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
            });
            await this.localClient.connect();
            console.log('✅ Connected to local MongoDB');

            // Connect to MongoDB Atlas
            this.atlasClient = new MongoClient(config.atlas.uri, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
            });
            await this.atlasClient.connect();
            console.log('✅ Connected to MongoDB Atlas');
        } catch (error) {
            console.error('❌ Connection failed:', error.message);
            throw error;
        }
    }

    async migrateCollection(collectionName) {
        console.log(`\n📦 Migrating collection: ${collectionName}`);
        
        try {
            const localDb = this.localClient.db(config.local.database);
            const atlasDb = this.atlasClient.db(config.atlas.database);
            
            const localCollection = localDb.collection(collectionName);
            const atlasCollection = atlasDb.collection(collectionName);
            
            // Check if collection exists in local database
            const collections = await localDb.listCollections({ name: collectionName }).toArray();
            if (collections.length === 0) {
                console.log(`⚠️  Collection '${collectionName}' not found in local database, skipping...`);
                return;
            }

            // Get total count
            const totalDocs = await localCollection.countDocuments();
            if (totalDocs === 0) {
                console.log(`📭 Collection '${collectionName}' is empty, skipping...`);
                this.stats.collections[collectionName] = { migrated: 0, total: 0 };
                return;
            }

            console.log(`📊 Found ${totalDocs} documents in ${collectionName}`);

            // Clear existing data in Atlas (optional - remove if you want to keep existing data)
            const existingCount = await atlasCollection.countDocuments();
            if (existingCount > 0) {
                console.log(`🗑️  Clearing ${existingCount} existing documents in Atlas...`);
                await atlasCollection.deleteMany({});
            }

            // Migrate in batches
            const batchSize = 1000;
            let migratedCount = 0;
            
            const cursor = localCollection.find({}).batchSize(batchSize);
            
            while (await cursor.hasNext()) {
                const batch = [];
                
                // Collect batch
                for (let i = 0; i < batchSize && await cursor.hasNext(); i++) {
                    const doc = await cursor.next();
                    batch.push(doc);
                }
                
                if (batch.length > 0) {
                    try {
                        await atlasCollection.insertMany(batch, { ordered: false });
                        migratedCount += batch.length;
                        console.log(`✅ Migrated ${migratedCount}/${totalDocs} documents`);
                    } catch (error) {
                        if (error.code === 11000) {
                            // Handle duplicate key errors
                            console.log(`⚠️  Some documents already exist, continuing...`);
                            migratedCount += batch.length;
                        } else {
                            throw error;
                        }
                    }
                }
            }

            this.stats.collections[collectionName] = { migrated: migratedCount, total: totalDocs };
            this.stats.migrated += migratedCount;
            this.stats.total += totalDocs;

            console.log(`✅ Completed migration of ${collectionName}: ${migratedCount}/${totalDocs} documents`);
            
        } catch (error) {
            console.error(`❌ Error migrating ${collectionName}:`, error.message);
            this.stats.collections[collectionName] = { migrated: 0, total: 0, error: error.message };
            this.stats.failed++;
        }
    }

    async createIndexes() {
        console.log('\n🔍 Creating optimized indexes...');
        
        try {
            const atlasDb = this.atlasClient.db(config.atlas.database);
            
            // Users indexes
            await atlasDb.collection('users').createIndex({ email: 1 }, { unique: true });
            await atlasDb.collection('users').createIndex({ date: -1 });
            await atlasDb.collection('users').createIndex({ verified: 1 });
            
            // Products indexes
            await atlasDb.collection('products').createIndex({ owner: 1 });
            await atlasDb.collection('products').createIndex({ published: 1 });
            await atlasDb.collection('products').createIndex({ createdAt: -1 });
            await atlasDb.collection('products').createIndex({ tags: 1 });
            
            // Contest indexes
            await atlasDb.collection('contests').createIndex({ owner: 1 });
            await atlasDb.collection('contests').createIndex({ published: 1 });
            await atlasDb.collection('contests').createIndex({ date: -1 });
            await atlasDb.collection('contests').createIndex({ code: 1 }, { unique: true });
            await atlasDb.collection('contests').createIndex({ category: 1 });
            await atlasDb.collection('contests').createIndex({ orgowner: 1 });
            
            // Organization indexes
            await atlasDb.collection('orgs').createIndex({ owner: 1 });
            await atlasDb.collection('orgs').createIndex({ code: 1 }, { unique: true });
            await atlasDb.collection('orgs').createIndex({ private: 1 });
            await atlasDb.collection('orgs').createIndex({ date: -1 });
            
            // API indexes
            await atlasDb.collection('apis').createIndex({ owner: 1 });
            await atlasDb.collection('apis').createIndex({ published: 1 });
            await atlasDb.collection('apis').createIndex({ code: 1 }, { unique: true });
            await atlasDb.collection('apis').createIndex({ category: 1 });
            await atlasDb.collection('apis').createIndex({ orgowner: 1 });
            await atlasDb.collection('apis').createIndex({ date: -1 });
            
            // API Subscribers indexes
            await atlasDb.collection('apisubscribers').createIndex({ apiId: 1 });
            await atlasDb.collection('apisubscribers').createIndex({ 'subscribers.appkey': 1 });
            
            // Contest Subscribers indexes
            await atlasDb.collection('contestsubscribers').createIndex({ contestId: 1 });
            await atlasDb.collection('contestsubscribers').createIndex({ 'subscribers.subscriberId': 1 });
            
            // Statistics indexes
            await atlasDb.collection('apistatistics').createIndex({ apiId: 1 });
            await atlasDb.collection('conteststatistics').createIndex({ contestId: 1 });
            await atlasDb.collection('orgstatistics').createIndex({ orgId: 1 });
            
            // Details indexes
            await atlasDb.collection('apidetails').createIndex({ apiId: 1 });
            await atlasDb.collection('contestdetails').createIndex({ contestId: 1 });
            await atlasDb.collection('orgdetails').createIndex({ orgId: 1 });
            
            // Endpoints and Plans
            await atlasDb.collection('apiendpoints').createIndex({ apiId: 1 });
            await atlasDb.collection('apiplans').createIndex({ apiId: 1 });
            
            // Requests
            await atlasDb.collection('requests').createIndex({ date: -1 });
            await atlasDb.collection('requests').createIndex({ appkey: 1 });
            await atlasDb.collection('requests').createIndex({ endpoint: 1 });
            
            console.log('✅ Indexes created successfully');
            
        } catch (error) {
            console.error('❌ Error creating indexes:', error.message);
        }
    }

    async validateMigration() {
        console.log('\n🔍 Validating migration...');
        
        try {
            const localDb = this.localClient.db(config.local.database);
            const atlasDb = this.atlasClient.db(config.atlas.database);
            
            for (const collection of collections) {
                const localCount = await localDb.collection(collection).countDocuments().catch(() => 0);
                const atlasCount = await atlasDb.collection(collection).countDocuments().catch(() => 0);
                
                if (localCount !== atlasCount) {
                    console.log(`⚠️  Mismatch in ${collection}: local=${localCount}, atlas=${atlasCount}`);
                } else if (localCount > 0) {
                    console.log(`✅ ${collection}: ${atlasCount} documents`);
                }
            }
            
        } catch (error) {
            console.error('❌ Validation error:', error.message);
        }
    }

    async disconnect() {
        try {
            if (this.localClient) {
                await this.localClient.close();
                console.log('🔌 Disconnected from local MongoDB');
            }
            if (this.atlasClient) {
                await this.atlasClient.close();
                console.log('🔌 Disconnected from MongoDB Atlas');
            }
        } catch (error) {
            console.error('❌ Error disconnecting:', error.message);
        }
    }

    printStats() {
        console.log('\n📈 Migration Statistics:');
        console.log('========================');
        console.log(`Total documents: ${this.stats.total}`);
        console.log(`Successfully migrated: ${this.stats.migrated}`);
        console.log(`Failed collections: ${this.stats.failed}`);
        console.log('\nPer collection:');
        
        Object.entries(this.stats.collections).forEach(([name, stats]) => {
            if (stats.error) {
                console.log(`❌ ${name}: ERROR - ${stats.error}`);
            } else {
                console.log(`✅ ${name}: ${stats.migrated}/${stats.total} documents`);
            }
        });
    }

    async migrate() {
        try {
            console.log('🚀 Starting MongoDB migration to Atlas...\n');
            
            await this.connect();
            
            // Migrate each collection
            for (const collection of collections) {
                await this.migrateCollection(collection);
            }
            
            // Create indexes for performance
            await this.createIndexes();
            
            // Validate migration
            await this.validateMigration();
            
            this.printStats();
            
            console.log('\n🎉 Migration completed successfully!');
            
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
    const migrator = new MongoMigrator();
    migrator.migrate().catch(console.error);
}

module.exports = MongoMigrator;