/**
 * Automated Backup System for AIAG Infrastructure
 * Handles database backups, file storage backups, and configuration backups
 */

const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

class AutomatedBackupSystem {
  constructor(config = {}) {
    this.config = {
      mongodb: {
        uri: process.env.MONGODB_URI || '',
        backupPath: './backups/mongodb',
        retention: 30, // days
        schedule: '0 2 * * *' // Daily at 2 AM
      },
      postgresql: {
        uri: process.env.DATABASE_URL || '',
        backupPath: './backups/postgresql',
        retention: 7, // days
        schedule: '0 3 * * *' // Daily at 3 AM
      },
      vercelBlob: {
        token: process.env.VERCEL_BLOB_READ_WRITE_TOKEN || '',
        backupPath: './backups/blob',
        retention: 14, // days
        schedule: '0 4 * * 0' // Weekly on Sunday at 4 AM
      },
      configurations: {
        backupPath: './backups/config',
        retention: 90, // days
        schedule: '0 1 * * *' // Daily at 1 AM
      },
      notifications: {
        webhook: process.env.BACKUP_WEBHOOK_URL || '',
        email: process.env.BACKUP_EMAIL || ''
      },
      storage: {
        type: 'local', // 'local', 's3', 'gcs'
        s3: {
          bucket: process.env.BACKUP_S3_BUCKET || '',
          region: process.env.BACKUP_S3_REGION || 'us-east-1',
          accessKeyId: process.env.BACKUP_S3_ACCESS_KEY || '',
          secretAccessKey: process.env.BACKUP_S3_SECRET_KEY || ''
        }
      },
      ...config
    };

    this.backupHistory = [];
    this.isRunning = false;
  }

  /**
   * Initialize backup system
   */
  async initialize() {
    console.log('Initializing Automated Backup System...');
    
    // Create backup directories
    await this.createBackupDirectories();
    
    // Verify prerequisites
    await this.verifyPrerequisites();
    
    console.log('Backup system initialized successfully');
  }

  /**
   * Create backup directories
   */
  async createBackupDirectories() {
    const directories = [
      this.config.mongodb.backupPath,
      this.config.postgresql.backupPath,
      this.config.vercelBlob.backupPath,
      this.config.configurations.backupPath
    ];

    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
        console.log(`Created backup directory: ${dir}`);
      } catch (error) {
        console.error(`Failed to create directory ${dir}:`, error.message);
      }
    }
  }

  /**
   * Verify prerequisites
   */
  async verifyPrerequisites() {
    const checks = [
      { name: 'mongodump', command: 'mongodump --version' },
      { name: 'pg_dump', command: 'pg_dump --version' },
      { name: 'tar', command: 'tar --version' },
      { name: 'gzip', command: 'gzip --version' }
    ];

    for (const check of checks) {
      try {
        await this.executeCommand(check.command);
        console.log(`✓ ${check.name} is available`);
      } catch (error) {
        console.warn(`⚠ ${check.name} is not available:`, error.message);
      }
    }
  }

  /**
   * Run all backup jobs
   */
  async runAllBackups() {
    if (this.isRunning) {
      console.log('Backup already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    const backupId = `backup_${Date.now()}`;

    console.log(`Starting backup job: ${backupId}`);

    const results = {
      id: backupId,
      startTime: new Date(startTime),
      endTime: null,
      duration: null,
      success: true,
      backups: []
    };

    try {
      // Run backups in sequence
      const backupJobs = [
        { name: 'configurations', fn: () => this.backupConfigurations() },
        { name: 'mongodb', fn: () => this.backupMongoDB() },
        { name: 'postgresql', fn: () => this.backupPostgreSQL() },
        { name: 'vercel-blob', fn: () => this.backupVercelBlob() }
      ];

      for (const job of backupJobs) {
        try {
          console.log(`Running ${job.name} backup...`);
          const jobResult = await job.fn();
          results.backups.push({
            type: job.name,
            success: true,
            ...jobResult
          });
          console.log(`✓ ${job.name} backup completed`);
        } catch (error) {
          console.error(`✗ ${job.name} backup failed:`, error.message);
          results.backups.push({
            type: job.name,
            success: false,
            error: error.message
          });
          results.success = false;
        }
      }

      // Cleanup old backups
      await this.cleanupOldBackups();

      // Upload to remote storage if configured
      if (this.config.storage.type !== 'local') {
        await this.uploadToRemoteStorage(results);
      }

    } catch (error) {
      console.error('Backup job failed:', error.message);
      results.success = false;
      results.error = error.message;
    }

    const endTime = Date.now();
    results.endTime = new Date(endTime);
    results.duration = endTime - startTime;

    this.backupHistory.push(results);
    this.isRunning = false;

    console.log(`Backup job completed in ${results.duration}ms`);

    // Send notifications
    await this.sendNotification(results);

    return results;
  }

  /**
   * Backup MongoDB database
   */
  async backupMongoDB() {
    if (!this.config.mongodb.uri) {
      throw new Error('MongoDB URI not configured');
    }

    const timestamp = this.getTimestamp();
    const backupPath = path.join(this.config.mongodb.backupPath, `mongodb_${timestamp}`);
    const archivePath = `${backupPath}.tar.gz`;

    try {
      // Create backup using mongodump
      await this.executeCommand(`mongodump --uri="${this.config.mongodb.uri}" --out="${backupPath}"`);
      
      // Compress backup
      await this.executeCommand(`tar -czf "${archivePath}" -C "${this.config.mongodb.backupPath}" "mongodb_${timestamp}"`);
      
      // Remove uncompressed backup
      await this.executeCommand(`rm -rf "${backupPath}"`);

      const stats = await fs.stat(archivePath);
      
      return {
        path: archivePath,
        size: stats.size,
        timestamp: new Date(),
        compressed: true
      };
    } catch (error) {
      // Cleanup on failure
      try {
        await this.executeCommand(`rm -rf "${backupPath}" "${archivePath}"`);
      } catch (cleanupError) {
        console.warn('Cleanup failed:', cleanupError.message);
      }
      throw error;
    }
  }

  /**
   * Backup PostgreSQL database
   */
  async backupPostgreSQL() {
    if (!this.config.postgresql.uri) {
      throw new Error('PostgreSQL URI not configured');
    }

    const timestamp = this.getTimestamp();
    const backupPath = path.join(this.config.postgresql.backupPath, `postgresql_${timestamp}.sql`);
    const archivePath = `${backupPath}.gz`;

    try {
      // Create backup using pg_dump
      await this.executeCommand(`pg_dump "${this.config.postgresql.uri}" > "${backupPath}"`);
      
      // Compress backup
      await this.executeCommand(`gzip "${backupPath}"`);

      const stats = await fs.stat(archivePath);
      
      return {
        path: archivePath,
        size: stats.size,
        timestamp: new Date(),
        compressed: true
      };
    } catch (error) {
      // Cleanup on failure
      try {
        await this.executeCommand(`rm -f "${backupPath}" "${archivePath}"`);
      } catch (cleanupError) {
        console.warn('Cleanup failed:', cleanupError.message);
      }
      throw error;
    }
  }

  /**
   * Backup Vercel Blob storage
   */
  async backupVercelBlob() {
    if (!this.config.vercelBlob.token) {
      console.warn('Vercel Blob token not configured, skipping blob backup');
      return {
        path: null,
        size: 0,
        timestamp: new Date(),
        skipped: true,
        reason: 'Token not configured'
      };
    }

    const timestamp = this.getTimestamp();
    const backupPath = path.join(this.config.vercelBlob.backupPath, `blob_${timestamp}`);
    
    try {
      await fs.mkdir(backupPath, { recursive: true });

      // List all blobs
      const blobs = await this.listVercelBlobs();
      
      // Download each blob
      let totalSize = 0;
      for (const blob of blobs) {
        const filePath = path.join(backupPath, blob.pathname);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        
        const fileSize = await this.downloadVercelBlob(blob.url, filePath);
        totalSize += fileSize;
      }

      // Create manifest
      const manifest = {
        timestamp: new Date(),
        blobCount: blobs.length,
        totalSize,
        blobs: blobs.map(b => ({ pathname: b.pathname, size: b.size, url: b.url }))
      };
      
      await fs.writeFile(
        path.join(backupPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      // Compress backup
      const archivePath = `${backupPath}.tar.gz`;
      await this.executeCommand(`tar -czf "${archivePath}" -C "${this.config.vercelBlob.backupPath}" "blob_${timestamp}"`);
      
      // Remove uncompressed backup
      await this.executeCommand(`rm -rf "${backupPath}"`);

      const stats = await fs.stat(archivePath);
      
      return {
        path: archivePath,
        size: stats.size,
        timestamp: new Date(),
        compressed: true,
        blobCount: blobs.length,
        originalSize: totalSize
      };
    } catch (error) {
      // Cleanup on failure
      try {
        await this.executeCommand(`rm -rf "${backupPath}" "${backupPath}.tar.gz"`);
      } catch (cleanupError) {
        console.warn('Cleanup failed:', cleanupError.message);
      }
      throw error;
    }
  }

  /**
   * Backup configurations and environment variables
   */
  async backupConfigurations() {
    const timestamp = this.getTimestamp();
    const backupPath = path.join(this.config.configurations.backupPath, `config_${timestamp}`);
    
    try {
      await fs.mkdir(backupPath, { recursive: true });

      // Backup Vercel project configurations
      try {
        const projects = ['ai-aggregator', 'aiag-hub'];
        for (const project of projects) {
          const envOutput = await this.executeCommand(`vercel env ls ${project}`);
          await fs.writeFile(
            path.join(backupPath, `${project}_env.txt`),
            envOutput
          );

          const projectInfo = await this.executeCommand(`vercel project ls --json`);
          await fs.writeFile(
            path.join(backupPath, `${project}_info.json`),
            projectInfo
          );
        }
      } catch (error) {
        console.warn('Failed to backup Vercel configurations:', error.message);
      }

      // Backup local configuration files
      const configFiles = [
        'deployment/domain-configuration.json',
        'deployment/monitoring-configuration.json',
        'deployment/environment-protection.json',
        'aiag_back/vercel.json',
        'aiaghub/vercel.json'
      ];

      for (const configFile of configFiles) {
        try {
          const sourcePath = path.join(process.cwd(), configFile);
          const destPath = path.join(backupPath, path.basename(configFile));
          await fs.copyFile(sourcePath, destPath);
        } catch (error) {
          console.warn(`Failed to backup ${configFile}:`, error.message);
        }
      }

      // Create backup manifest
      const manifest = {
        timestamp: new Date(),
        backupType: 'configurations',
        files: await this.listFiles(backupPath)
      };
      
      await fs.writeFile(
        path.join(backupPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      // Compress backup
      const archivePath = `${backupPath}.tar.gz`;
      await this.executeCommand(`tar -czf "${archivePath}" -C "${this.config.configurations.backupPath}" "config_${timestamp}"`);
      
      // Remove uncompressed backup
      await this.executeCommand(`rm -rf "${backupPath}"`);

      const stats = await fs.stat(archivePath);
      
      return {
        path: archivePath,
        size: stats.size,
        timestamp: new Date(),
        compressed: true
      };
    } catch (error) {
      // Cleanup on failure
      try {
        await this.executeCommand(`rm -rf "${backupPath}" "${backupPath}.tar.gz"`);
      } catch (cleanupError) {
        console.warn('Cleanup failed:', cleanupError.message);
      }
      throw error;
    }
  }

  /**
   * Clean up old backups based on retention policy
   */
  async cleanupOldBackups() {
    const cleanupTasks = [
      { path: this.config.mongodb.backupPath, retention: this.config.mongodb.retention },
      { path: this.config.postgresql.backupPath, retention: this.config.postgresql.retention },
      { path: this.config.vercelBlob.backupPath, retention: this.config.vercelBlob.retention },
      { path: this.config.configurations.backupPath, retention: this.config.configurations.retention }
    ];

    for (const task of cleanupTasks) {
      try {
        await this.cleanupDirectory(task.path, task.retention);
      } catch (error) {
        console.warn(`Failed to cleanup ${task.path}:`, error.message);
      }
    }
  }

  /**
   * Clean up directory based on retention days
   */
  async cleanupDirectory(dirPath, retentionDays) {
    try {
      const files = await fs.readdir(dirPath);
      const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
          console.log(`Deleted old backup: ${filePath}`);
        }
      }
    } catch (error) {
      console.error(`Error cleaning up ${dirPath}:`, error.message);
    }
  }

  /**
   * List Vercel Blobs
   */
  async listVercelBlobs() {
    // This is a placeholder - actual implementation would use Vercel Blob API
    // For now, return empty array
    console.warn('Vercel Blob listing not implemented yet');
    return [];
  }

  /**
   * Download Vercel Blob
   */
  async downloadVercelBlob(url, filePath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let totalSize = 0;

      https.get(url, (response) => {
        response.pipe(file);
        
        response.on('data', (chunk) => {
          totalSize += chunk.length;
        });
        
        file.on('finish', () => {
          file.close();
          resolve(totalSize);
        });
        
        file.on('error', (error) => {
          fs.unlink(filePath);
          reject(error);
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Send notification about backup status
   */
  async sendNotification(results) {
    const message = this.formatNotificationMessage(results);
    
    if (this.config.notifications.webhook) {
      try {
        await this.sendWebhookNotification(message, results);
      } catch (error) {
        console.error('Failed to send webhook notification:', error.message);
      }
    }
    
    if (this.config.notifications.email) {
      try {
        await this.sendEmailNotification(message, results);
      } catch (error) {
        console.error('Failed to send email notification:', error.message);
      }
    }
  }

  /**
   * Format notification message
   */
  formatNotificationMessage(results) {
    const emoji = results.success ? '✅' : '❌';
    const status = results.success ? 'SUCCESS' : 'FAILED';
    
    let message = `${emoji} AIAG Backup ${status}\n\n`;
    message += `Job ID: ${results.id}\n`;
    message += `Duration: ${Math.round(results.duration / 1000)}s\n`;
    message += `Timestamp: ${results.endTime.toISOString()}\n\n`;
    
    message += 'Backup Results:\n';
    for (const backup of results.backups) {
      const icon = backup.success ? '✓' : '✗';
      message += `${icon} ${backup.type}`;
      
      if (backup.success && backup.size) {
        message += ` (${this.formatBytes(backup.size)})`;
      } else if (!backup.success) {
        message += ` - ${backup.error}`;
      }
      message += '\n';
    }
    
    return message;
  }

  /**
   * Send webhook notification
   */
  async sendWebhookNotification(message, results) {
    const payload = JSON.stringify({
      text: message,
      success: results.success,
      timestamp: results.endTime.toISOString(),
      backups: results.backups
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.config.notifications.webhook);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Webhook returned ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Send email notification (placeholder)
   */
  async sendEmailNotification(message, results) {
    console.log('Email notification:', message);
    // TODO: Implement email sending via your preferred service
  }

  /**
   * Execute command and return output
   */
  executeCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${error.message}\nStderr: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Get timestamp string
   */
  getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
           new Date().toISOString().replace(/[:.]/g, '-').split('T')[1].split('.')[0];
  }

  /**
   * Format bytes to human readable string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * List files in directory recursively
   */
  async listFiles(dirPath) {
    const files = [];
    
    async function traverse(currentPath) {
      const items = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const item of items) {
        const fullPath = path.join(currentPath, item.name);
        
        if (item.isDirectory()) {
          await traverse(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          files.push({
            path: path.relative(dirPath, fullPath),
            size: stats.size,
            mtime: stats.mtime
          });
        }
      }
    }
    
    await traverse(dirPath);
    return files;
  }

  /**
   * Get backup status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastBackup: this.backupHistory[this.backupHistory.length - 1] || null,
      totalBackups: this.backupHistory.length,
      successRate: this.backupHistory.length > 0 ? 
        (this.backupHistory.filter(b => b.success).length / this.backupHistory.length * 100).toFixed(2) : 0
    };
  }
}

// CLI usage
if (require.main === module) {
  const backupSystem = new AutomatedBackupSystem();
  
  async function runBackup() {
    try {
      await backupSystem.initialize();
      const result = await backupSystem.runAllBackups();
      
      console.log('\nBackup Summary:');
      console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`Duration: ${Math.round(result.duration / 1000)}s`);
      console.log(`Backups: ${result.backups.filter(b => b.success).length}/${result.backups.length} successful`);
      
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error('Backup failed:', error.message);
      process.exit(1);
    }
  }
  
  runBackup();
}

module.exports = AutomatedBackupSystem;