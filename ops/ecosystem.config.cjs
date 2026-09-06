/**
 * AI Aggregator pm2 process contract.
 *
 * The deploy workflows copy this file to
 * `/srv/aiag/shared/ecosystem.config.cjs` before pm2 self-heal. Every cwd uses
 * the app-specific `current` symlink so an atomic release swap takes effect on
 * restart. The external server copy is not assumed or verified from checkout.
 */

const SHARED_ENV = '/srv/aiag/shared/.env';
const current = (app) => `/srv/aiag/${app}/current`;

module.exports = {
  apps: [
    {
      name: 'web',
      cwd: current('web'),
      script: 'node_modules/.bin/next',
      args: 'start apps/web -p 3000',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      env_file: SHARED_ENV,
      env: { NODE_ENV: 'production', PORT: '3000' },
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'gateway',
      cwd: current('gateway'),
      script: 'packages/api-gateway/dist/server-node.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      env_file: SHARED_ENV,
      env: { NODE_ENV: 'production', PORT: '4000' },
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: 'worker',
      cwd: current('worker'),
      script: 'apps/worker/dist/index.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      env_file: SHARED_ENV,
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
