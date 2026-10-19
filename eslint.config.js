'use strict';

const sharedGlobals = Object.fromEntries([
  'AbortSignal', 'Blob', 'Buffer', 'CSS', 'CustomEvent', 'DOMParser', 'Element',
  'Event', 'FileReader', 'FormData', 'Headers', 'IDBKeyRange', 'Map',
  'MutationObserver', 'Node', 'NodeFilter', 'Promise', 'Request', 'Response',
  'Set', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'Uint8Array',
  'alert', 'atob', 'btoa', 'chrome', 'clearInterval', 'clearTimeout', 'console',
  'crypto', 'document', 'fetch', 'globalThis', 'importScripts', 'indexedDB',
  'location', 'navigator', 'performance', 'queueMicrotask', 'setInterval',
  'setTimeout', 'structuredClone', 'window',
].map((name) => [name, 'readonly']));

module.exports = [
  {
    ignores: [
      'node_modules/**', 'dist/**', 'build/**', 'coverage/**',
      'playwright-report/**', 'test-results/**', 'report/**', 'temp/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...sharedGlobals,
        module: 'readonly', require: 'readonly', process: 'readonly',
        __dirname: 'readonly', exports: 'writable', global: 'writable',
        isFinite: 'readonly', parseFloat: 'readonly', parseInt: 'readonly',
        bupgogaePrecedentBadge: 'readonly',
        isValidCssSelector: 'readonly', sanitizeAdaptersConfig: 'readonly',
        validateVersionDate: 'readonly', validateDbIntegrity: 'readonly', buildFetchPlan: 'readonly',
        shouldLoadBundled: 'readonly', validateManifest: 'readonly',
        evaluateDrift: 'readonly', appendLedger: 'readonly',
      },
    },
    rules: {
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-constant-binary-expression': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-obj-calls': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-with': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['**/__tests__/**/*.js', 'e2e/**/*.js', 'jest.setup.js'],
    languageOptions: {
      globals: Object.fromEntries([
        'afterAll', 'afterEach', 'beforeAll', 'beforeEach', 'describe', 'expect',
        'it', 'jest', 'test',
      ].map((name) => [name, 'readonly'])),
    },
  },
];
