const mongoose = require('mongoose');

/**
 * MongoDB Atlas Indexes Configuration
 * Optimized indexes for AI Aggregator collections
 */

const indexConfigurations = {
    // Users collection indexes
    users: [
        { email: 1 }, // Unique index for email
        { verified: 1 }, // Index for verified status
        { date: -1 }, // Index for date sorting
        { email: 1, verified: 1 } // Compound index for login queries
    ],

    // Products collection indexes
    products: [
        { title: 'text', description: 'text' }, // Text search index
        { owner: 1 }, // Index for owner queries
        { published: 1 }, // Index for published status
        { createdAt: -1 }, // Index for date sorting
        { tags: 1 }, // Index for tag filtering
        { collections: 1 }, // Index for collection filtering
        { published: 1, createdAt: -1 }, // Compound index for published products
        { owner: 1, published: 1 } // Compound index for owner's published products
    ],

    // Contests collection indexes
    contests: [
        { title: 'text', shortdescription: 'text' }, // Text search index
        { owner: 1 }, // Index for owner queries
        { published: 1 }, // Index for published status
        { date: -1 }, // Index for date sorting
        { category: 1 }, // Index for category filtering
        { private: 1 }, // Index for privacy filtering
        { orgowner: 1 }, // Index for organization owner
        { published: 1, date: -1 }, // Compound index for published contests
        { owner: 1, published: 1 }, // Compound index for owner's published contests
        { category: 1, published: 1 } // Compound index for category filtering
    ],

    // Contest details indexes
    contestdetails: [
        { contestId: 1 } // Index for contest reference
    ],

    // Contest statistics indexes
    conteststatistics: [
        { contestId: 1 }, // Index for contest reference
        { clicks: -1 }, // Index for click sorting
        { subscribers: -1 } // Index for subscriber sorting
    ],

    // Contest subscribers indexes
    contestsubscribers: [
        { contestId: 1 }, // Index for contest reference
        { 'subscribers.subscriberId': 1 }, // Index for subscriber queries
        { 'subscribers.entrydate': -1 } // Index for entry date sorting
    ],

    // Contest data indexes
    contestdatas: [
        { contestId: 1 } // Index for contest reference
    ],

    // Contest timelines indexes
    contesttimelines: [
        { contestId: 1 }, // Index for contest reference
        { 'stages.startdate': 1 }, // Index for stage start dates
        { 'stages.enddate': 1 } // Index for stage end dates
    ],

    // Organizations indexes
    orgs: [
        { name: 'text', description: 'text' }, // Text search index
        { owner: 1 }, // Index for owner queries
        { verified: 1 }, // Index for verified status
        { type: 1 }, // Index for organization type
        { public: 1 } // Index for public status
    ],

    // API schemas indexes
    apischemas: [
        { title: 'text', description: 'text' }, // Text search index
        { owner: 1 }, // Index for owner queries
        { published: 1 }, // Index for published status
        { category: 1 }, // Index for category filtering
        { private: 1 }, // Index for privacy filtering
        { orgowner: 1 } // Index for organization owner
    ],

    // Requests indexes
    requests: [
        { owner: 1 }, // Index for owner queries
        { date: -1 }, // Index for date sorting
        { status: 1 }, // Index for status filtering
        { category: 1 } // Index for category filtering
    ],

    // Categories indexes
    categories: [
        { name: 1 }, // Index for category name
        { type: 1 } // Index for category type
    ],

    // Tags indexes
    tags: [
        { name: 1 }, // Index for tag name
        { type: 1 } // Index for tag type
    ],

    // Pricing indexes
    pricings: [
        { productId: 1 }, // Index for product reference
        { planType: 1 } // Index for plan type
    ],

    // User details indexes
    userdetails: [
        { userId: 1 } // Index for user reference
    ],

    // User statistics indexes
    userstatistics: [
        { userId: 1 } // Index for user reference
    ]
};

/**
 * Create indexes for all collections
 */
async function createIndexes() {
    try {
        console.log('Creating MongoDB Atlas indexes...');
        
        for (const [collectionName, indexes] of Object.entries(indexConfigurations)) {
            try {
                const collection = mongoose.connection.db.collection(collectionName);
                
                for (const index of indexes) {
                    // Check if it's a text index
                    const isTextIndex = Object.values(index).includes('text');
                    const options = isTextIndex ? { 
                        background: true,
                        default_language: 'english'
                    } : { 
                        background: true 
                    };

                    // Special handling for unique indexes
                    if (collectionName === 'users' && index.email === 1) {
                        options.unique = true;
                    }

                    await collection.createIndex(index, options);
                    console.log(`✓ Created index for ${collectionName}:`, index);
                }
            } catch (error) {
                if (error.code === 85) { // Index already exists
                    console.log(`⚠ Index already exists for ${collectionName}`);
                } else {
                    console.error(`✗ Failed to create index for ${collectionName}:`, error.message);
                }
            }
        }
        
        console.log('✓ Indexes creation completed');
    } catch (error) {
        console.error('Failed to create indexes:', error);
        throw error;
    }
}

/**
 * Drop all indexes for a collection (for rebuild)
 */
async function dropIndexes(collectionName) {
    try {
        const collection = mongoose.connection.db.collection(collectionName);
        await collection.dropIndexes();
        console.log(`✓ Dropped all indexes for ${collectionName}`);
    } catch (error) {
        console.error(`✗ Failed to drop indexes for ${collectionName}:`, error.message);
        throw error;
    }
}

/**
 * Get index statistics for a collection
 */
async function getIndexStats(collectionName) {
    try {
        const collection = mongoose.connection.db.collection(collectionName);
        const stats = await collection.indexStats();
        return stats;
    } catch (error) {
        console.error(`Failed to get index stats for ${collectionName}:`, error.message);
        throw error;
    }
}

/**
 * Analyze query performance with explain
 */
async function analyzeQuery(collectionName, query, options = {}) {
    try {
        const collection = mongoose.connection.db.collection(collectionName);
        const explanation = await collection.find(query, options).explain('executionStats');
        
        return {
            totalDocsExamined: explanation.executionStats.totalDocsExamined,
            totalDocsReturned: explanation.executionStats.totalDocsReturned,
            executionTimeMillis: explanation.executionStats.executionTimeMillis,
            indexesUsed: explanation.executionStats.executionStages?.indexName || 'COLLSCAN'
        };
    } catch (error) {
        console.error(`Failed to analyze query for ${collectionName}:`, error.message);
        throw error;
    }
}

module.exports = {
    indexConfigurations,
    createIndexes,
    dropIndexes,
    getIndexStats,
    analyzeQuery
};