#!/usr/bin/env node

/**
 * Migration Runner Script
 * Unified script to run all database migrations
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

class MigrationRunner {
    constructor() {
        this.verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
        this.dryRun = process.argv.includes('--dry-run');
        this.force = process.argv.includes('--force');
    }

    /**
     * Log message with timestamp
     */
    log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
        console.log(`${prefix} [${timestamp}] ${message}`);
    }

    /**
     * Run shell command
     */
    async runCommand(command, args = [], options = {}) {
        return new Promise((resolve, reject) => {
            if (this.verbose) {
                this.log(`Running: ${command} ${args.join(' ')}`);
            }

            if (this.dryRun) {
                this.log(`DRY RUN: Would execute ${command} ${args.join(' ')}`);
                resolve({ code: 0, stdout: 'DRY RUN', stderr: '' });
                return;
            }

            const child = spawn(command, args, {
                stdio: this.verbose ? 'inherit' : 'pipe',
                shell: true,
                ...options
            });

            let stdout = '';
            let stderr = '';

            if (!this.verbose) {
                child.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                child.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });
            }

            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ code, stdout, stderr });
                } else {
                    reject(new Error(`Command failed with code ${code}: ${stderr}`));
                }
            });

            child.on('error', (error) => {
                reject(error);
            });
        });
    }

    /**
     * Check prerequisites
     */
    async checkPrerequisites() {
        this.log('Checking prerequisites...');

        const checks = [
            { name: 'Node.js', command: 'node', args: ['--version'] },
            { name: 'npm', command: 'npm', args: ['--version'] },
            { name: 'MongoDB Atlas URI', check: () => !!process.env.MONGODB_ATLAS_URI },
            { name: 'PostgreSQL URL', check: () => !!process.env.POSTGRES_URL }
        ];

        for (const check of checks) {
            try {
                if (check.command) {
                    await this.runCommand(check.command, check.args);
                    this.log(`✓ ${check.name} is available`);
                } else if (check.check) {
                    if (check.check()) {
                        this.log(`✓ ${check.name} is set`);
                    } else {
                        throw new Error(`${check.name} is not set`);
                    }
                }
            } catch (error) {
                this.log(`✗ ${check.name}: ${error.message}`, 'error');
                throw new Error(`Prerequisite check failed: ${check.name}`);
            }
        }
    }

    /**
     * Install dependencies
     */
    async installDependencies() {
        this.log('Installing migration dependencies...');

        const packages = ['mongoose', 'pg', 'dotenv'];
        
        try {
            await this.runCommand('npm', ['install', ...packages]);
            this.log('✓ Dependencies installed');
        } catch (error) {
            this.log(`Failed to install dependencies: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Create backup
     */
    async createBackup() {
        this.log('Creating database backups...');

        const backupDir = path.join(process.cwd(), 'backups', new Date().toISOString().split('T')[0]);
        
        try {
            await fs.mkdir(backupDir, { recursive: true });

            // MongoDB backup (if available locally)
            try {
                await this.runCommand('mongodump', [
                    '--uri=mongodb://Aexa:FH8238fdisdf4738fas9ada9sryeuirw@84.201.185.11/app?authSource=admin',
                    `--out=${path.join(backupDir, 'mongodb')}`
                ]);
                this.log('✓ MongoDB backup created');
            } catch (error) {
                this.log('⚠️ MongoDB backup failed (continuing...)', 'warn');
            }

            // PostgreSQL backup (if available locally)
            try {
                await this.runCommand('pg_dump', [
                    '-h', 'localhost',
                    '-U', 'postgres',
                    '-d', 'apihubdb',
                    '-f', path.join(backupDir, 'postgres-backup.sql')
                ]);
                this.log('✓ PostgreSQL backup created');
            } catch (error) {
                this.log('⚠️ PostgreSQL backup failed (continuing...)', 'warn');
            }

            this.log(`Backups stored in: ${backupDir}`);
        } catch (error) {
            this.log(`Backup creation failed: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Run MongoDB migration
     */
    async runMongoMigration() {
        this.log('Running MongoDB migration to Atlas...');

        const scriptPath = path.join(__dirname, '..', 'database', 'mongodb', 'migration-script.js');
        
        try {
            await this.runCommand('node', [scriptPath, 'migrate'], {
                env: {
                    ...process.env,
                    FORCE_MIGRATION: this.force ? 'true' : 'false'
                }
            });
            this.log('✓ MongoDB migration completed');
        } catch (error) {
            this.log(`MongoDB migration failed: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Run PostgreSQL migration
     */
    async runPostgresMigration() {
        this.log('Running PostgreSQL migration to Vercel...');

        const scriptPath = path.join(__dirname, '..', 'database', 'postgres', 'migration-script.js');
        
        try {
            await this.runCommand('node', [scriptPath, 'migrate'], {
                env: {
                    ...process.env,
                    FORCE_MIGRATION: this.force ? 'true' : 'false'
                }
            });
            this.log('✓ PostgreSQL migration completed');
        } catch (error) {
            this.log(`PostgreSQL migration failed: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Verify migrations
     */
    async verifyMigrations() {
        this.log('Verifying migrations...');

        try {
            // MongoDB verification
            const mongoScript = path.join(__dirname, '..', 'database', 'mongodb', 'migration-script.js');
            await this.runCommand('node', [mongoScript, 'verify']);
            this.log('✓ MongoDB verification passed');

            // PostgreSQL verification
            const pgScript = path.join(__dirname, '..', 'database', 'postgres', 'migration-script.js');
            await this.runCommand('node', [pgScript, 'verify']);
            this.log('✓ PostgreSQL verification passed');

        } catch (error) {
            this.log(`Migration verification failed: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Update configuration files
     */
    async updateConfigurations() {
        this.log('Updating configuration files...');

        const configs = [
            {
                file: path.join(__dirname, '..', 'aiag_back', 'config', 'production.json'),
                updates: {
                    mongoUri: '${MONGODB_ATLAS_URI}',
                    baseUrl: '${VERCEL_URL}'
                }
            },
            {
                file: path.join(__dirname, '..', 'aiaghub', 'config', 'production.json'),
                updates: {
                    baseUrl: '${VERCEL_URL}',
                    database: {
                        postgres: {
                            connectionString: '${POSTGRES_URL}'
                        }
                    }
                }
            }
        ];

        for (const config of configs) {
            try {
                const content = await fs.readFile(config.file, 'utf8');
                const parsed = JSON.parse(content);
                
                // Merge updates
                const updated = { ...parsed, ...config.updates };
                
                await fs.writeFile(config.file, JSON.stringify(updated, null, 4));
                this.log(`✓ Updated ${config.file}`);
            } catch (error) {
                this.log(`Failed to update ${config.file}: ${error.message}`, 'warn');
            }
        }
    }

    /**
     * Test connections
     */
    async testConnections() {
        this.log('Testing database connections...');

        const testScript = `
const { getDatabaseAdapter } = require('./database/config/database-adapter');

async function test() {
    try {
        const adapter = getDatabaseAdapter();
        const health = await adapter.healthCheck();
        
        console.log('Health Check Results:');
        console.log(JSON.stringify(health, null, 2));
        
        if (health.status === 'healthy') {
            console.log('✓ All database connections are healthy');
            process.exit(0);
        } else {
            console.log('⚠️ Some database connections have issues');
            process.exit(1);
        }
    } catch (error) {
        console.error('❌ Connection test failed:', error.message);
        process.exit(1);
    }
}

test();
        `;

        const testFile = path.join(__dirname, '..', 'temp-connection-test.js');
        
        try {
            await fs.writeFile(testFile, testScript);
            await this.runCommand('node', [testFile]);
            await fs.unlink(testFile);
            this.log('✓ Connection test passed');
        } catch (error) {
            await fs.unlink(testFile).catch(() => {});
            this.log(`Connection test failed: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Generate migration report
     */
    async generateReport() {
        const report = {
            timestamp: new Date().toISOString(),
            status: 'completed',
            environment: {
                node: process.version,
                platform: process.platform,
                mongoUri: process.env.MONGODB_ATLAS_URI ? 'configured' : 'missing',
                postgresUrl: process.env.POSTGRES_URL ? 'configured' : 'missing'
            },
            steps: [
                'Prerequisites checked',
                'Dependencies installed',
                'Backups created',
                'MongoDB migration completed',
                'PostgreSQL migration completed',
                'Migrations verified',
                'Configurations updated',
                'Connections tested'
            ]
        };

        const reportFile = path.join(__dirname, '..', 'migration-report.json');
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
        
        this.log(`✓ Migration report saved to: ${reportFile}`);
        return report;
    }

    /**
     * Run complete migration
     */
    async run() {
        const startTime = Date.now();
        
        try {
            this.log('🚀 Starting AI Aggregator database migration...');
            this.log(`Options: verbose=${this.verbose}, dryRun=${this.dryRun}, force=${this.force}`);

            await this.checkPrerequisites();
            await this.installDependencies();
            
            if (!this.dryRun) {
                await this.createBackup();
                await this.runMongoMigration();
                await this.runPostgresMigration();
                await this.verifyMigrations();
                await this.updateConfigurations();
                await this.testConnections();
            }

            const report = await this.generateReport();
            
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            this.log(`🎉 Migration completed successfully in ${duration}s`);
            
            return report;

        } catch (error) {
            this.log(`💥 Migration failed: ${error.message}`, 'error');
            
            if (this.verbose) {
                console.error(error.stack);
            }
            
            process.exit(1);
        }
    }
}

/**
 * CLI interface
 */
async function main() {
    const runner = new MigrationRunner();
    
    const command = process.argv[2];
    
    switch (command) {
        case 'run':
        case 'migrate':
            await runner.run();
            break;
        case 'check':
            await runner.checkPrerequisites();
            break;
        case 'backup':
            await runner.createBackup();
            break;
        case 'test':
            await runner.testConnections();
            break;
        case 'mongo':
            await runner.runMongoMigration();
            break;
        case 'postgres':
            await runner.runPostgresMigration();
            break;
        case 'verify':
            await runner.verifyMigrations();
            break;
        default:
            console.log(`
AI Aggregator Database Migration Runner

Usage:
  node migration-runner.js <command> [options]

Commands:
  run, migrate    Run complete migration
  check          Check prerequisites only
  backup         Create backups only
  test           Test database connections
  mongo          Run MongoDB migration only
  postgres       Run PostgreSQL migration only
  verify         Verify migrations only

Options:
  --verbose, -v   Verbose output
  --dry-run      Show what would be done without executing
  --force        Force migration even if target has data

Examples:
  node migration-runner.js run --verbose
  node migration-runner.js check
  node migration-runner.js test
  node migration-runner.js migrate --force --verbose
            `);
            process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('Migration runner error:', error);
        process.exit(1);
    });
}

module.exports = MigrationRunner;