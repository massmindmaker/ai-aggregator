/**
 * Health Check Monitoring System
 * Monitors application health and sends alerts
 */

const https = require('https');
const http = require('http');

class HealthCheckMonitor {
  constructor(config = {}) {
    this.config = {
      checks: {
        'ai-aggregator-prod': {
          url: 'https://aiag.ai/api/health',
          interval: 30000, // 30 seconds
          timeout: 10000,  // 10 seconds
          expectedStatus: [200, 206],
          expectedContent: 'healthy',
          retryAttempts: 3,
          retryDelay: 5000
        },
        'ai-aggregator-staging': {
          url: 'https://staging.aiag.ai/api/health',
          interval: 60000, // 1 minute
          timeout: 10000,
          expectedStatus: [200, 206],
          expectedContent: 'healthy',
          retryAttempts: 2,
          retryDelay: 5000
        },
        'aiag-hub-prod': {
          url: 'https://hub.aiag.ai/health',
          interval: 30000,
          timeout: 10000,
          expectedStatus: [200, 206],
          expectedContent: 'healthy',
          retryAttempts: 3,
          retryDelay: 5000
        },
        'aiag-hub-staging': {
          url: 'https://staging-hub.aiag.ai/health',
          interval: 60000,
          timeout: 10000,
          expectedStatus: [200, 206],
          expectedContent: 'healthy',
          retryAttempts: 2,
          retryDelay: 5000
        },
        'aiag-hub-current': {
          url: 'https://aiag-hub.vercel.app/health',
          interval: 60000,
          timeout: 10000,
          expectedStatus: [200, 206],
          expectedContent: 'healthy',
          retryAttempts: 2,
          retryDelay: 5000
        }
      },
      alerting: {
        email: {
          enabled: true,
          addresses: ['admin@aiag.ai', 'alerts@massmindmakers.com']
        },
        webhook: {
          enabled: true,
          url: process.env.SLACK_WEBHOOK_URL || '',
          format: 'slack'
        },
        cooldown: 300000 // 5 minutes between same alerts
      },
      ...config
    };

    this.monitors = new Map();
    this.alertCooldowns = new Map();
    this.metrics = {
      checks: new Map(),
      alerts: [],
      uptime: new Map()
    };
  }

  /**
   * Start monitoring all configured health checks
   */
  start() {
    console.log('Starting health check monitoring...');
    
    for (const [name, config] of Object.entries(this.config.checks)) {
      this.startMonitor(name, config);
    }

    // Start metrics collection
    this.startMetricsCollection();
  }

  /**
   * Stop all monitoring
   */
  stop() {
    console.log('Stopping health check monitoring...');
    
    for (const [name, intervalId] of this.monitors) {
      clearInterval(intervalId);
    }
    
    this.monitors.clear();
  }

  /**
   * Start monitoring a specific service
   */
  startMonitor(name, config) {
    console.log(`Starting monitor for ${name}: ${config.url}`);
    
    // Initial check
    this.performHealthCheck(name, config);
    
    // Schedule recurring checks
    const intervalId = setInterval(() => {
      this.performHealthCheck(name, config);
    }, config.interval);
    
    this.monitors.set(name, intervalId);
    
    // Initialize metrics
    this.metrics.checks.set(name, {
      total: 0,
      successful: 0,
      failed: 0,
      lastCheck: null,
      lastSuccess: null,
      lastFailure: null,
      responseTime: [],
      status: 'unknown'
    });
    
    this.metrics.uptime.set(name, {
      startTime: Date.now(),
      totalDowntime: 0,
      currentOutageStart: null
    });
  }

  /**
   * Perform health check for a service
   */
  async performHealthCheck(name, config) {
    const startTime = Date.now();
    const metrics = this.metrics.checks.get(name);
    
    try {
      const result = await this.makeHealthCheckRequest(config.url, config.timeout);
      const responseTime = Date.now() - startTime;
      
      // Update metrics
      metrics.total++;
      metrics.lastCheck = new Date();
      metrics.responseTime.push(responseTime);
      
      // Keep only last 100 response times
      if (metrics.responseTime.length > 100) {
        metrics.responseTime = metrics.responseTime.slice(-100);
      }
      
      // Check if response is healthy
      const isHealthy = this.isResponseHealthy(result, config);
      
      if (isHealthy) {
        metrics.successful++;
        metrics.lastSuccess = new Date();
        metrics.status = 'healthy';
        
        // End outage if there was one
        const uptimeMetrics = this.metrics.uptime.get(name);
        if (uptimeMetrics.currentOutageStart) {
          uptimeMetrics.totalDowntime += Date.now() - uptimeMetrics.currentOutageStart;
          uptimeMetrics.currentOutageStart = null;
          
          // Send recovery alert
          await this.sendAlert(name, 'recovery', {
            url: config.url,
            responseTime,
            timestamp: new Date()
          });
        }
        
        console.log(`✓ ${name}: Healthy (${responseTime}ms)`);
      } else {
        await this.handleFailedCheck(name, config, result, responseTime);
      }
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      await this.handleFailedCheck(name, config, { error: error.message }, responseTime);
    }
  }

  /**
   * Handle failed health check
   */
  async handleFailedCheck(name, config, result, responseTime) {
    const metrics = this.metrics.checks.get(name);
    
    // Retry logic
    let retrySuccess = false;
    for (let i = 0; i < config.retryAttempts; i++) {
      console.log(`Retrying ${name} (attempt ${i + 1}/${config.retryAttempts})...`);
      
      await this.sleep(config.retryDelay);
      
      try {
        const retryResult = await this.makeHealthCheckRequest(config.url, config.timeout);
        if (this.isResponseHealthy(retryResult, config)) {
          retrySuccess = true;
          console.log(`✓ ${name}: Recovered on retry ${i + 1}`);
          break;
        }
      } catch (retryError) {
        console.log(`✗ ${name}: Retry ${i + 1} failed: ${retryError.message}`);
      }
    }
    
    if (!retrySuccess) {
      metrics.failed++;
      metrics.lastFailure = new Date();
      metrics.status = 'unhealthy';
      
      // Start outage tracking
      const uptimeMetrics = this.metrics.uptime.get(name);
      if (!uptimeMetrics.currentOutageStart) {
        uptimeMetrics.currentOutageStart = Date.now();
        
        // Send alert
        await this.sendAlert(name, 'failure', {
          url: config.url,
          error: result.error || 'Health check failed',
          responseTime,
          timestamp: new Date(),
          retryAttempts: config.retryAttempts
        });
      }
      
      console.log(`✗ ${name}: Failed after ${config.retryAttempts} retries`);
    }
  }

  /**
   * Make HTTP request for health check
   */
  makeHealthCheckRequest(url, timeout) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': 'AIAG-HealthCheck/1.0',
          'Accept': 'application/json'
        }
      };
      
      const req = client.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.end();
    });
  }

  /**
   * Check if response indicates healthy service
   */
  isResponseHealthy(result, config) {
    if (result.error) return false;
    
    // Check status code
    if (!config.expectedStatus.includes(result.statusCode)) {
      return false;
    }
    
    // Check content if specified
    if (config.expectedContent && !result.body.includes(config.expectedContent)) {
      return false;
    }
    
    return true;
  }

  /**
   * Send alert
   */
  async sendAlert(serviceName, type, details) {
    const alertKey = `${serviceName}-${type}`;
    const now = Date.now();
    
    // Check cooldown
    const lastAlert = this.alertCooldowns.get(alertKey);
    if (lastAlert && (now - lastAlert) < this.config.alerting.cooldown) {
      return;
    }
    
    this.alertCooldowns.set(alertKey, now);
    
    const alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      service: serviceName,
      type,
      details,
      severity: type === 'failure' ? 'critical' : 'info'
    };
    
    this.metrics.alerts.push(alert);
    
    // Keep only last 1000 alerts
    if (this.metrics.alerts.length > 1000) {
      this.metrics.alerts = this.metrics.alerts.slice(-1000);
    }
    
    console.log(`🚨 ALERT: ${serviceName} - ${type}`, details);
    
    // Send to configured channels
    if (this.config.alerting.email.enabled) {
      await this.sendEmailAlert(alert);
    }
    
    if (this.config.alerting.webhook.enabled && this.config.alerting.webhook.url) {
      await this.sendWebhookAlert(alert);
    }
  }

  /**
   * Send email alert (placeholder - requires email service integration)
   */
  async sendEmailAlert(alert) {
    console.log('Email alert:', alert);
    // TODO: Integrate with email service (SendGrid, SES, etc.)
  }

  /**
   * Send webhook alert (Slack, Discord, etc.)
   */
  async sendWebhookAlert(alert) {
    try {
      const payload = this.formatWebhookPayload(alert);
      
      const urlObj = new URL(this.config.alerting.webhook.url);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      
      const req = client.request(options, (res) => {
        console.log(`Webhook alert sent: ${res.statusCode}`);
      });
      
      req.on('error', (error) => {
        console.error('Webhook alert failed:', error);
      });
      
      req.write(payload);
      req.end();
      
    } catch (error) {
      console.error('Webhook alert error:', error);
    }
  }

  /**
   * Format webhook payload
   */
  formatWebhookPayload(alert) {
    if (this.config.alerting.webhook.format === 'slack') {
      const color = alert.type === 'failure' ? 'danger' : 'good';
      const emoji = alert.type === 'failure' ? '🚨' : '✅';
      
      return JSON.stringify({
        text: `${emoji} AIAG Health Check Alert`,
        attachments: [{
          color,
          fields: [
            {
              title: 'Service',
              value: alert.service,
              short: true
            },
            {
              title: 'Status',
              value: alert.type,
              short: true
            },
            {
              title: 'URL',
              value: alert.details.url,
              short: false
            },
            {
              title: 'Error',
              value: alert.details.error || 'N/A',
              short: false
            },
            {
              title: 'Timestamp',
              value: alert.timestamp.toISOString(),
              short: true
            }
          ]
        }]
      });
    }
    
    return JSON.stringify(alert);
  }

  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    // Export metrics every 5 minutes
    setInterval(() => {
      this.exportMetrics();
    }, 300000);
  }

  /**
   * Export metrics
   */
  exportMetrics() {
    const metrics = {
      timestamp: new Date().toISOString(),
      checks: {},
      uptime: {},
      alerts: this.metrics.alerts.slice(-50) // Last 50 alerts
    };
    
    // Process check metrics
    for (const [name, data] of this.metrics.checks) {
      const responseTime = data.responseTime;
      metrics.checks[name] = {
        ...data,
        responseTime: {
          avg: responseTime.length ? responseTime.reduce((a, b) => a + b, 0) / responseTime.length : 0,
          min: responseTime.length ? Math.min(...responseTime) : 0,
          max: responseTime.length ? Math.max(...responseTime) : 0,
          count: responseTime.length
        },
        successRate: data.total ? (data.successful / data.total * 100).toFixed(2) : 0
      };
    }
    
    // Process uptime metrics
    for (const [name, data] of this.metrics.uptime) {
      const totalTime = Date.now() - data.startTime;
      const downtime = data.totalDowntime + (data.currentOutageStart ? Date.now() - data.currentOutageStart : 0);
      
      metrics.uptime[name] = {
        uptimePercentage: ((totalTime - downtime) / totalTime * 100).toFixed(4),
        totalDowntime: downtime,
        isCurrentlyDown: !!data.currentOutageStart
      };
    }
    
    console.log('Health Check Metrics:', JSON.stringify(metrics, null, 2));
    
    // TODO: Send metrics to monitoring service (Grafana, DataDog, etc.)
  }

  /**
   * Get current status
   */
  getStatus() {
    const status = {
      overall: 'healthy',
      services: {},
      timestamp: new Date().toISOString()
    };
    
    let hasUnhealthy = false;
    
    for (const [name, data] of this.metrics.checks) {
      status.services[name] = {
        status: data.status,
        lastCheck: data.lastCheck,
        successRate: data.total ? (data.successful / data.total * 100).toFixed(2) : 0
      };
      
      if (data.status === 'unhealthy') {
        hasUnhealthy = true;
      }
    }
    
    if (hasUnhealthy) {
      status.overall = 'degraded';
    }
    
    return status;
  }

  /**
   * Utility function for sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// CLI usage
if (require.main === module) {
  const monitor = new HealthCheckMonitor();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down health check monitor...');
    monitor.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('Shutting down health check monitor...');
    monitor.stop();
    process.exit(0);
  });
  
  monitor.start();
}

module.exports = HealthCheckMonitor;