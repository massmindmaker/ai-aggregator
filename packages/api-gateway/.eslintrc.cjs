/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  ignorePatterns: ['dist/**', 'node_modules/**'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    'no-async-promise-executor': 'error',
    'no-debugger': 'error',
    'no-unexpected-multiline': 'error',
    'no-unsafe-finally': 'error',
    'valid-typeof': 'error',
  },
};
