let Pool;
try {
  ({ Pool } = require('pg'));
} catch (error) {
  throw new Error('PostgreSQL support requires the "pg" package. Run npm install first.');
}
const fs = require('fs');

const { withTransaction } = require('./repositoryUtils.cjs');

let sharedPool = null;

const SSL_URL_PARAMETERS = new Set([
  'ssl',
  'sslmode',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'uselibpqcompat',
]);

function connectionStringWithoutSslParameters(connectionString) {
  try {
    const parsed = new URL(connectionString);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SSL_URL_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function readTlsFile(filePath, label) {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const wrapped = new Error(`Unable to read PostgreSQL TLS ${label} file`);
    wrapped.code = 'PG_TLS_FILE_UNREADABLE';
    wrapped.cause = error;
    throw wrapped;
  }
}

function normalizeSslConfig(ssl) {
  if (ssl == null || typeof ssl === 'boolean') return ssl;
  if (!ssl.mode) return { ...ssl };
  if (ssl.mode === 'disable') return false;
  const options = {
    rejectUnauthorized: ssl.mode === 'verify-full',
  };
  const ca = readTlsFile(ssl.rootCertPath, 'root certificate');
  const cert = readTlsFile(ssl.certPath, 'client certificate');
  const key = readTlsFile(ssl.keyPath, 'client key');
  if (ca !== undefined) options.ca = ca;
  if (cert !== undefined) options.cert = cert;
  if (key !== undefined) options.key = key;
  return options;
}

function normalizeDatabaseConfig(config) {
  const source = config && config.database ? config.database : config || {};
  const url = source.url || source.connectionString;
  if (!url) throw new Error('DATABASE_URL is required to create the PostgreSQL pool');
  const normalized = {
    connectionString: source.ssl === undefined
      ? url
      : connectionStringWithoutSslParameters(url),
    application_name: source.applicationName || source.application_name || 'pytaskgantt',
    max: source.maxConnections || source.max || 10,
    idleTimeoutMillis: source.idleTimeoutMs || source.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: source.connectionTimeoutMs || source.connectionTimeoutMillis || 5000,
  };
  if (source.ssl !== undefined) normalized.ssl = normalizeSslConfig(source.ssl);
  return normalized;
}

function createPool(config) {
  const pool = new Pool(normalizeDatabaseConfig(config));
  const onError = config && config.onError;
  pool.on('error', error => {
    if (typeof onError === 'function') return onError(error);
    // pg emits idle-client failures on Pool; registering a listener prevents an
    // opaque uncaught EventEmitter crash while keeping credentials out of logs.
    console.error(`Unexpected PostgreSQL pool error: ${error.message}`);
  });
  return pool;
}

function getPool(config) {
  if (!sharedPool) sharedPool = createPool(config);
  return sharedPool;
}

async function closePool() {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.end();
}

module.exports = {
  createPool,
  getPool,
  closePool,
  withTransaction,
  normalizeDatabaseConfig,
  normalizeSslConfig,
  connectionStringWithoutSslParameters,
};
