const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeDatabaseConfig,
  connectionStringWithoutSslParameters,
} = require('../server/db/pool.cjs');

test('pool marks PostgreSQL sessions with an application_name by default', () => {
  const normalized = normalizeDatabaseConfig({
    database: { url: 'postgresql://app:password@db.example/tasks' },
  });
  assert.equal(normalized.application_name, 'pytaskgantt');
  assert.equal(normalized.connectionString, 'postgresql://app:password@db.example/tasks');
  assert.equal(Object.hasOwn(normalized, 'ssl'), false);
});

test('pool applies explicit TLS verification and removes URL options that could override it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pytaskgantt-tls-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rootCertPath = path.join(directory, 'root.pem');
  const clientCertPath = path.join(directory, 'client.pem');
  const clientKeyPath = path.join(directory, 'client.key');
  fs.writeFileSync(rootCertPath, 'test-root-ca');
  fs.writeFileSync(clientCertPath, 'test-client-cert');
  fs.writeFileSync(clientKeyPath, 'test-client-key');

  const normalized = normalizeDatabaseConfig({
    database: {
      url: 'postgresql://app:password@db.example/tasks?sslmode=require&sslrootcert=%2Fignored.pem&application_name=url-name',
      applicationName: 'url-name',
      ssl: {
        mode: 'verify-full',
        rootCertPath,
        certPath: clientCertPath,
        keyPath: clientKeyPath,
      },
    },
  });

  const parsed = new URL(normalized.connectionString);
  assert.equal(parsed.searchParams.get('sslmode'), null);
  assert.equal(parsed.searchParams.get('sslrootcert'), null);
  assert.equal(parsed.searchParams.get('application_name'), 'url-name');
  assert.deepEqual(normalized.ssl, {
    rejectUnauthorized: true,
    ca: 'test-root-ca',
    cert: 'test-client-cert',
    key: 'test-client-key',
  });
});

test('require mode encrypts without certificate verification and unreadable files fail safely', () => {
  const encrypted = normalizeDatabaseConfig({
    database: {
      url: 'postgresql://app:password@db.example/tasks',
      ssl: { mode: 'require', rootCertPath: '', certPath: '', keyPath: '' },
    },
  });
  assert.deepEqual(encrypted.ssl, { rejectUnauthorized: false });

  assert.throws(
    () => normalizeDatabaseConfig({
      database: {
        url: 'postgresql://app:password@db.example/tasks',
        ssl: { mode: 'verify-full', rootCertPath: '/missing/test-ca.pem' },
      },
    }),
    error => error.code === 'PG_TLS_FILE_UNREADABLE' &&
      !error.message.includes('/missing/test-ca.pem')
  );
});

test('SSL query stripping preserves credentials and unrelated connection parameters', () => {
  const sanitized = connectionStringWithoutSslParameters(
    'postgresql://app:p%40ss@db.example/tasks?sslmode=verify-full&connect_timeout=5'
  );
  assert.equal(
    sanitized,
    'postgresql://app:p%40ss@db.example/tasks?connect_timeout=5'
  );
});
