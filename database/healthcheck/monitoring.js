const EventEmitter = require('events');
const { getDatabaseAdapter } = require('../config/database-adapter');

/**
 * Database Monitoring Service
 * Continuous monitoring of database health with alerts and metrics
 */

class DatabaseMonitor extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            checkInterval: options.checkInterval || 30000, // 30 seconds
            alertThreshold: options.alertThreshold || 3, // 3 consecutive failures
            performanceThreshold: options.performanceThreshold || 1000, // 1 second
            enabled: options.enabled !== false,
            ...options
        };
        
        this.failureCount = {
            mongodb: 0,
            postgresql: 0
        };
        
        this.lastCheck = {
            mongodb: null,
            postgresql: null
        };
        
        this.metrics = {
            mongodb: {
                uptime: 0,
                downtime: 0,
                avgResponseTime: 0,
                checks: 0
            },
            postgresql: {
                uptime: 0,
                downtime: 0,
                avgResponseTime: 0,
                checks: 0
            }
        };
        
        this.monitorInterval = null;
        this.isRunning = false;
    }

    /**
     * Start monitoring
     */
    start() {
        if (this.isRunning || !this.options.enabled) {
            return;
        }

        console.log('🔍 Starting database monitoring...');
        this.isRunning = true;
        
        // Initial check
        this.performHealthCheck();
        
        // Schedule periodic checks
        this.monitorInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.options.checkInterval);

        this.emit('monitoring_started');
    }

    /**
     * Stop monitoring
     */
    stop() {
        if (!this.isRunning) {
            return;
        }

        console.log('🛑 Stopping database monitoring...');
        
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        
        this.isRunning = false;
        this.emit('monitoring_stopped');
    }

    /**
     * Perform health check on all databases
     */
    async performHealthCheck() {
        try {
            const adapter = getDatabaseAdapter();
            
            // Check MongoDB
            if (adapter.shouldUseMongoDB()) {
                await this.checkMongoDB();
            }
            
            // Check PostgreSQL
            if (adapter.shouldUsePostgreSQL()) {
                await this.checkPostgreSQL();
            }
            
        } catch (error) {
            console.error('Health check error:', error);
            this.emit('check_error', error);
        }
    }

    /**
     * Check MongoDB health
     */
    async checkMongoDB() {
        const startTime = Date.now();
        
        try {
            const adapter = getDatabaseAdapter();
            const mongo = await adapter.getMongoDB();
            const health = await mongo.healthCheck();
            
            const responseTime = Date.now() - startTime;
            const isHealthy = health.status === 'connected';
            
            this.updateMetrics('mongodb', isHealthy, responseTime);
            
            if (isHealthy) {
                this.failureCount.mongodb = 0;
                this.lastCheck.mongodb = {
                    status: 'healthy',
                    timestamp: new Date(),
                    responseTime,
                    details: health
                };
                
                this.emit('mongodb_healthy', { responseTime, health });
            } else {
                this.handleFailure('mongodb', health, responseTime);
            }
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            this.handleFailure('mongodb', { error: error.message }, responseTime);
        }
    }

    /**
     * Check PostgreSQL health
     */
    async checkPostgreSQL() {
        const startTime = Date.now();
        
        try {
            const adapter = getDatabaseAdapter();
            const postgres = await adapter.getPostgreSQL();
            const health = await postgres.healthCheck();
            
            const responseTime = Date.now() - startTime;
            const isHealthy = health.status === 'connected';
            
            this.updateMetrics('postgresql', isHealthy, responseTime);
            
            if (isHealthy) {
                this.failureCount.postgresql = 0;
                this.lastCheck.postgresql = {
                    status: 'healthy',
                    timestamp: new Date(),
                    responseTime,
                    details: health
                };
                
                this.emit('postgresql_healthy', { responseTime, health });
            } else {
                this.handleFailure('postgresql', health, responseTime);
            }
            
        } catch (error) {
            const responseTime = Date.now() - startTime;
            this.handleFailure('postgresql', { error: error.message }, responseTime);
        }
    }

    /**
     * Handle database failure
     */
    handleFailure(database, healthData, responseTime) {
        this.failureCount[database]++;
        
        this.lastCheck[database] = {
            status: 'unhealthy',
            timestamp: new Date(),
            responseTime,
            details: healthData,
            failureCount: this.failureCount[database]
        };
        
        this.updateMetrics(database, false, responseTime);
        
        this.emit(`${database}_unhealthy`, {
            responseTime,
            failureCount: this.failureCount[database],
            details: healthData
        });
        
        // Trigger alert if threshold reached
        if (this.failureCount[database] >= this.options.alertThreshold) {
            this.triggerAlert(database, healthData);
        }
    }

    /**
     * Update performance metrics
     */
    updateMetrics(database, isHealthy, responseTime) {
        const metrics = this.metrics[database];
        
        metrics.checks++;
        
        if (isHealthy) {
            metrics.uptime++;
            // Update average response time
            metrics.avgResponseTime = ((metrics.avgResponseTime * (metrics.uptime - 1)) + responseTime) / metrics.uptime;
        } else {
            metrics.downtime++;
        }
        
        // Check performance threshold
        if (responseTime > this.options.performanceThreshold) {
            this.emit('performance_warning', {
                database,
                responseTime,
                threshold: this.options.performanceThreshold
            });
        }
    }

    /**
     * Trigger alert for database issues
     */
    triggerAlert(database, healthData) {
        const alert = {
            type: 'database_alert',
            database,
            severity: 'critical',
            message: `Database ${database} has failed ${this.failureCount[database]} consecutive health checks`,
            details: healthData,
            timestamp: new Date(),
            failureCount: this.failureCount[database]
        };
        
        console.error('🚨 DATABASE ALERT:', alert);
        this.emit('alert', alert);
        
        // Reset failure count to avoid spam
        if (this.failureCount[database] >= this.options.alertThreshold * 2) {
            this.failureCount[database] = this.options.alertThreshold;
        }
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            options: this.options,
            lastChecks: this.lastCheck,
            failureCounts: this.failureCount,
            metrics: this.metrics,
            uptime: this.getUptime()
        };
    }

    /**
     * Get uptime statistics
     */
    getUptime() {
        const stats = {};
        
        for (const [database, metrics] of Object.entries(this.metrics)) {
            const totalChecks = metrics.checks;
            if (totalChecks > 0) {
                stats[database] = {
                    uptimePercentage: (metrics.uptime / totalChecks) * 100,
                    downtimePercentage: (metrics.downtime / totalChecks) * 100,
                    totalChecks,
                    avgResponseTime: metrics.avgResponseTime,
                    uptime: metrics.uptime,
                    downtime: metrics.downtime
                };
            }
        }
        
        return stats;
    }

    /**
     * Reset metrics and counters
     */
    resetMetrics() {
        this.failureCount = {
            mongodb: 0,
            postgresql: 0
        };
        
        this.metrics = {
            mongodb: {
                uptime: 0,
                downtime: 0,
                avgResponseTime: 0,
                checks: 0
            },
            postgresql: {
                uptime: 0,
                downtime: 0,
                avgResponseTime: 0,
                checks: 0
            }
        };
        
        this.emit('metrics_reset');
    }

    /**
     * Get health summary
     */
    getHealthSummary() {
        const summary = {
            overall: 'healthy',
            databases: {},
            timestamp: new Date()
        };
        
        for (const database of ['mongodb', 'postgresql']) {
            const lastCheck = this.lastCheck[database];
            const failureCount = this.failureCount[database];
            
            if (!lastCheck) {
                summary.databases[database] = 'unknown';
            } else if (lastCheck.status === 'healthy') {
                summary.databases[database] = 'healthy';
            } else if (failureCount < this.options.alertThreshold) {
                summary.databases[database] = 'degraded';
                summary.overall = 'degraded';
            } else {
                summary.databases[database] = 'critical';
                summary.overall = 'critical';
            }
        }
        
        return summary;
    }
}

/**
 * Create and configure monitor instance
 */
function createDatabaseMonitor(options = {}) {
    const monitor = new DatabaseMonitor(options);
    
    // Set up event listeners for logging
    monitor.on('mongodb_healthy', ({ responseTime }) => {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`✓ MongoDB healthy (${responseTime}ms)`);
        }
    });
    
    monitor.on('postgresql_healthy', ({ responseTime }) => {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`✓ PostgreSQL healthy (${responseTime}ms)`);
        }
    });
    
    monitor.on('mongodb_unhealthy', ({ failureCount, details }) => {
        console.warn(`⚠ MongoDB unhealthy (failures: ${failureCount})`, details);
    });
    
    monitor.on('postgresql_unhealthy', ({ failureCount, details }) => {
        console.warn(`⚠ PostgreSQL unhealthy (failures: ${failureCount})`, details);
    });
    
    monitor.on('alert', (alert) => {
        console.error('🚨 DATABASE ALERT:', alert);
        // Here you could integrate with external alerting systems
        // like Slack, PagerDuty, email, etc.
    });
    
    monitor.on('performance_warning', ({ database, responseTime, threshold }) => {
        console.warn(`⚠ ${database} performance warning: ${responseTime}ms > ${threshold}ms`);
    });
    
    return monitor;
}

// Singleton monitor instance
let globalMonitor = null;

/**
 * Get global monitor instance
 */
function getGlobalMonitor() {
    if (!globalMonitor) {
        globalMonitor = createDatabaseMonitor({
            enabled: process.env.DB_MONITORING_ENABLED !== 'false'
        });
    }
    return globalMonitor;
}

module.exports = {
    DatabaseMonitor,
    createDatabaseMonitor,
    getGlobalMonitor
};