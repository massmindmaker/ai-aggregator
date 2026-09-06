#!/usr/bin/env node

const path = require('node:path');

const configPath = path.resolve(process.argv[2] || 'ops/ecosystem.config.cjs');
const config = require(configPath);
const apps = Array.isArray(config.apps) ? config.apps : [];

const expected = {
  web: {
    cwd: '/srv/aiag/web/current',
    script: 'node_modules/.bin/next',
    args: 'start apps/web -p 3000',
  },
  gateway: {
    cwd: '/srv/aiag/gateway/current',
    script: 'packages/api-gateway/dist/server-node.js',
  },
  worker: {
    cwd: '/srv/aiag/worker/current',
    script: 'apps/worker/dist/index.js',
  },
};

const errors = [];
const names = apps.map((app) => app.name).sort();
const expectedNames = Object.keys(expected).sort();

if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
  errors.push(`process names must be exactly ${expectedNames.join(', ')}; got ${names.join(', ')}`);
}

for (const [name, contract] of Object.entries(expected)) {
  const app = apps.find((candidate) => candidate.name === name);
  if (!app) continue;

  for (const [key, value] of Object.entries(contract)) {
    if (app[key] !== value) {
      errors.push(`${name}.${key} must be ${JSON.stringify(value)}; got ${JSON.stringify(app[key])}`);
    }
  }

  if (app.interpreter !== 'node') {
    errors.push(`${name}.interpreter must be "node"`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`ecosystem contract ok: ${expectedNames.join(', ')}`);
