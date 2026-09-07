const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');

const MINIMUM_NODE_VERSION = [20, 12, 0];

function assertSupportedNode(version = process.versions.node, parseEnvFeature = parseEnv) {
  const actual = version.split('.').map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (actual[index] > MINIMUM_NODE_VERSION[index]) break;
    if (actual[index] < MINIMUM_NODE_VERSION[index]) {
      throw new Error(
        `AIAG deployment requires Node.js >= ${MINIMUM_NODE_VERSION.join('.')} (found ${version})`,
      );
    }
  }
  if (typeof parseEnvFeature !== 'function') {
    throw new Error(
      `AIAG deployment requires node:util.parseEnv support (unavailable in Node.js ${version})`,
    );
  }
}

function loadRuntimeEnv(filePath) {
  assertSupportedNode();
  return parseEnv(readFileSync(filePath, 'utf8'));
}

module.exports = { MINIMUM_NODE_VERSION, assertSupportedNode, loadRuntimeEnv };
