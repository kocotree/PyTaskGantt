const test = require('node:test');
const assert = require('node:assert/strict');

const { createConfig, ConfigError } = require('../server/config.cjs');

test('database-only tools can validate DATABASE_URL without application secrets', () => {
  const config = createConfig(
    { DATABASE_URL: 'postgresql://example.invalid/app', AUTH_MODE: 'dev' },
    { requireSession: false, requireYingdao: false }
  );
  assert.equal(config.database.url, 'postgresql://example.invalid/app');
  assert.equal(config.database.maxConnections, 10);
  assert.equal(config.database.applicationName, 'pytaskgantt');
  assert.equal(config.database.ssl.mode, 'disable');
  assert.equal(config.session.tableName, 'app_sessions');

  const productionToolConfig = createConfig(
    { NODE_ENV: 'production', DATABASE_URL: 'postgresql://example.invalid/app' },
    { requireSession: false, requireYingdao: false, validateApplication: false }
  );
  assert.equal(productionToolConfig.isProduction, true);
  assert.equal(productionToolConfig.database.ssl.mode, 'disable');
});

test('database-only tools can generate DATABASE_URL from standard PG variables', () => {
  const config = createConfig(
    {
      PGHOST: 'db.internal',
      PGPORT: '5432',
      PGDATABASE: 'task board',
      PGUSER: 'migration user',
      PGPASSWORD: 'secret@value',
      AUTH_MODE: 'dev',
    },
    { requireSession: false, requireYingdao: false }
  );

  assert.equal(
    config.database.url,
    'postgresql://migration%20user:secret%40value@db.internal:5432/task%20board'
  );
  assert.equal(config.database.applicationName, 'pytaskgantt');
});

test('application defaults require database, session, and Yingdao credentials', () => {
  assert.throws(
    () => createConfig({ AUTH_MODE: 'dev' }),
    error => error instanceof ConfigError && error.key === 'DATABASE_URL'
  );
  assert.throws(
    () => createConfig({ DATABASE_URL: 'postgresql://example.invalid/app', AUTH_MODE: 'dev' }),
    error => error instanceof ConfigError && error.key === 'SESSION_SECRET'
  );
});

test('production rejects wildcard CORS and accidental development auth', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/app',
    SESSION_SECRET: 'x'.repeat(32),
    YINGDAO_ACCESS_KEY_ID: 'id',
    YINGDAO_ACCESS_KEY_SECRET: 'secret',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'feishu-secret',
    FEISHU_REDIRECT_URI: 'https://example.com/api/auth/feishu/callback',
    APP_BASE_URL: 'https://example.com',
  };
  assert.throws(
    () => createConfig({ ...base, AUTH_MODE: 'dev', CORS_ORIGIN: 'https://example.com' }),
    error => error.key === 'AUTH_MODE'
  );
  assert.throws(
    () => createConfig({ ...base, AUTH_MODE: 'feishu', CORS_ORIGIN: '*' }),
    error => error.key === 'CORS_ORIGIN'
  );
  const encryptedWithoutVerification = createConfig({
    ...base,
    AUTH_MODE: 'feishu',
    CORS_ORIGIN: 'https://example.com',
    PGSSLMODE: 'require',
  });
  assert.equal(encryptedWithoutVerification.database.ssl.mode, 'require');
});
