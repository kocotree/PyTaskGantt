const path = require('path');

class ConfigError extends Error {
  constructor(message, key) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'INVALID_CONFIG';
    this.key = key;
  }
}

let dotenvLoaded = false;

function loadEnvFile(envPath = path.resolve(__dirname, '..', '.env')) {
  if (dotenvLoaded) return;
  // dotenv remains the only file-based configuration loader. Callers may pass a
  // plain object to createConfig() in tests without touching process.env.
  require('dotenv').config({ path: envPath, quiet: true });
  dotenvLoaded = true;
}

function textValue(env, key, fallback = '') {
  const value = env[key];
  if (value == null) return fallback;
  return String(value).trim();
}

function rawValue(env, key, fallback = '') {
  const value = env[key];
  if (value == null) return fallback;
  return String(value);
}

function requiredValue(env, key) {
  const value = textValue(env, key);
  if (!value) throw new ConfigError(`${key} is required`, key);
  return value;
}

const DATABASE_URL_PART_KEYS = Object.freeze([
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
]);

const DATABASE_SSL_MODES = Object.freeze(['disable', 'require', 'verify-full']);
const DATABASE_SSL_FILE_KEYS = Object.freeze([
  ['PGSSLROOTCERT', 'sslrootcert'],
  ['PGSSLCERT', 'sslcert'],
  ['PGSSLKEY', 'sslkey'],
]);

function resolveDatabaseUrl(env, { required = true } = {}) {
  const explicitUrl = textValue(env, 'DATABASE_URL');
  if (explicitUrl) return explicitUrl;

  const values = {
    PGHOST: textValue(env, 'PGHOST'),
    PGPORT: textValue(env, 'PGPORT'),
    PGDATABASE: rawValue(env, 'PGDATABASE'),
    PGUSER: rawValue(env, 'PGUSER'),
    // A quoted password may intentionally contain leading or trailing spaces.
    PGPASSWORD: rawValue(env, 'PGPASSWORD'),
  };
  const missing = DATABASE_URL_PART_KEYS.filter(key => !values[key]);
  if (missing.length > 0) {
    if (!required) return '';
    const message = missing.length === DATABASE_URL_PART_KEYS.length
      ? `DATABASE_URL is required, or provide ${DATABASE_URL_PART_KEYS.join(', ')}`
      : `DATABASE_URL cannot be generated because ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`;
    throw new ConfigError(message, 'DATABASE_URL');
  }

  const port = positiveInteger(env, 'PGPORT', 5432, { max: 65535 });
  const rawHost = values.PGHOST;
  if (/[\s/@?#]/.test(rawHost)) {
    throw new ConfigError('PGHOST must be a hostname or IP address when generating DATABASE_URL', 'DATABASE_URL');
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost
    : rawHost.includes(':')
      ? `[${rawHost}]`
      : rawHost;

  try {
    const databaseUrl = `postgresql://${encodeURIComponent(values.PGUSER)}:${encodeURIComponent(values.PGPASSWORD)}@${host}:${port}/${encodeURIComponent(values.PGDATABASE)}`;
    // Parse once so malformed hosts fail during configuration instead of later
    // as an opaque PostgreSQL connection error.
    const parsedUrl = new URL(databaseUrl);
    // pg-connection-string decodes the path with decodeURI, which intentionally
    // leaves URI delimiters encoded. Reject names that would silently target a
    // different database after parsing.
    if (decodeURI(parsedUrl.pathname.slice(1)) !== values.PGDATABASE) {
      throw new ConfigError(
        'PGDATABASE contains characters that cannot be represented safely in DATABASE_URL',
        'DATABASE_URL'
      );
    }
    return databaseUrl;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('Unable to generate DATABASE_URL from PostgreSQL settings', 'DATABASE_URL');
  }
}

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new ConfigError('DATABASE_URL must use the postgres or postgresql protocol', 'DATABASE_URL');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('DATABASE_URL must be a valid PostgreSQL URL', 'DATABASE_URL');
  }
}

function uniqueUrlParameter(parsedUrl, key) {
  if (!parsedUrl) return '';
  const values = parsedUrl.searchParams.getAll(key);
  if (values.length > 1) {
    throw new ConfigError(`DATABASE_URL must not repeat ${key}`, 'DATABASE_URL');
  }
  return values[0] == null ? '' : String(values[0]).trim();
}

function normalizeDatabaseSslMode(value, key) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return '';
  if (!DATABASE_SSL_MODES.includes(mode)) {
    throw new ConfigError(
      `${key} must be one of ${DATABASE_SSL_MODES.join(', ')}`,
      key
    );
  }
  return mode;
}

function urlDatabaseSslMode(parsedUrl) {
  const sslMode = normalizeDatabaseSslMode(
    uniqueUrlParameter(parsedUrl, 'sslmode'),
    'DATABASE_URL'
  );
  const sslValue = uniqueUrlParameter(parsedUrl, 'ssl').toLowerCase();
  let legacyMode = '';
  if (sslValue) {
    if (['true', '1'].includes(sslValue)) legacyMode = 'verify-full';
    else if (['false', '0'].includes(sslValue)) legacyMode = 'disable';
    else if (sslValue === 'no-verify') legacyMode = 'require';
    else throw new ConfigError('DATABASE_URL contains an unsupported ssl value', 'DATABASE_URL');
  }
  if (sslMode && legacyMode && sslMode !== legacyMode) {
    throw new ConfigError('DATABASE_URL contains conflicting ssl and sslmode settings', 'DATABASE_URL');
  }
  return sslMode || legacyMode;
}

function resolveDatabaseSslPath(env, parsedUrl, envKey, urlKey) {
  const envPath = textValue(env, envKey);
  const urlPath = uniqueUrlParameter(parsedUrl, urlKey);
  if (envPath && urlPath && envPath !== urlPath) {
    throw new ConfigError(`${envKey} conflicts with DATABASE_URL ${urlKey}`, envKey);
  }
  const resolved = urlPath || envPath;
  if (resolved && !path.isAbsolute(resolved)) {
    throw new ConfigError(`${envKey} must be an absolute path`, envKey);
  }
  return resolved;
}

function resolveDatabaseSsl(env, parsedUrl) {
  const envMode = normalizeDatabaseSslMode(textValue(env, 'PGSSLMODE'), 'PGSSLMODE');
  const urlMode = urlDatabaseSslMode(parsedUrl);
  if (envMode && urlMode && envMode !== urlMode) {
    throw new ConfigError('PGSSLMODE conflicts with DATABASE_URL sslmode', 'PGSSLMODE');
  }

  const paths = Object.fromEntries(DATABASE_SSL_FILE_KEYS.map(([envKey, urlKey]) => [
    envKey,
    resolveDatabaseSslPath(env, parsedUrl, envKey, urlKey),
  ]));
  const hasTlsFile = Object.values(paths).some(Boolean);
  const mode = urlMode || envMode || (hasTlsFile ? 'verify-full' : 'disable');

  if (mode === 'disable' && hasTlsFile) {
    throw new ConfigError('PostgreSQL TLS certificate files require PGSSLMODE=require or verify-full', 'PGSSLMODE');
  }
  if (paths.PGSSLROOTCERT && mode !== 'verify-full') {
    throw new ConfigError('PGSSLROOTCERT requires PGSSLMODE=verify-full', 'PGSSLROOTCERT');
  }
  if (Boolean(paths.PGSSLCERT) !== Boolean(paths.PGSSLKEY)) {
    throw new ConfigError('PGSSLCERT and PGSSLKEY must be configured together', 'PGSSLCERT');
  }
  return {
    mode,
    rootCertPath: paths.PGSSLROOTCERT,
    certPath: paths.PGSSLCERT,
    keyPath: paths.PGSSLKEY,
  };
}

function resolveDatabaseApplicationName(env, parsedUrl) {
  const fromUrl = uniqueUrlParameter(parsedUrl, 'application_name');
  const applicationName = fromUrl || textValue(env, 'PGAPPNAME', 'pytaskgantt');
  if (!applicationName || /[\u0000-\u001f\u007f]/.test(applicationName)) {
    throw new ConfigError('PGAPPNAME must be a non-empty value without control characters', 'PGAPPNAME');
  }
  if (Buffer.byteLength(applicationName, 'utf8') > 63) {
    throw new ConfigError('PGAPPNAME must not exceed 63 UTF-8 bytes', 'PGAPPNAME');
  }
  return applicationName;
}

function resolveCorsConfig(env, { isProduction, validateApplication }) {
  const rawOrigin = textValue(env, 'CORS_ORIGIN', '*');
  const values = rawOrigin.split(',').map(value => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new ConfigError('CORS_ORIGIN must contain at least one origin', 'CORS_ORIGIN');
  }
  if (values.includes('*')) {
    if (values.length !== 1) {
      throw new ConfigError('CORS_ORIGIN cannot combine * with explicit origins', 'CORS_ORIGIN');
    }
    if (validateApplication && isProduction) {
      throw new ConfigError('CORS_ORIGIN must be an explicit HTTPS allowlist in production', 'CORS_ORIGIN');
    }
    return { origin: '*', origins: ['*'] };
  }

  const origins = [];
  for (const value of values) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ConfigError(`CORS_ORIGIN contains an invalid origin: ${value}`, 'CORS_ORIGIN');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash ||
        parsed.hostname.includes('*')) {
      throw new ConfigError(`CORS_ORIGIN must contain only exact HTTP(S) origins: ${value}`, 'CORS_ORIGIN');
    }
    if (validateApplication && isProduction && parsed.protocol !== 'https:') {
      throw new ConfigError('CORS_ORIGIN must contain only HTTPS origins in production', 'CORS_ORIGIN');
    }
    if (!origins.includes(parsed.origin)) origins.push(parsed.origin);
  }
  return { origin: origins.join(','), origins };
}

function positiveInteger(env, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = textValue(env, key, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}`, key);
  }
  return value;
}

function booleanValue(env, key, fallback = false) {
  const raw = textValue(env, key, fallback ? 'true' : 'false').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false`, key);
}

function freezeNested(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeNested(child);
  return Object.freeze(value);
}

/**
 * Build validated runtime configuration.
 *
 * Migration and repository tools only need a database connection (an explicit
 * DATABASE_URL or the complete PG* set), so they can opt out of session/Yingdao
 * validation without weakening the application defaults.
 */
function createConfig(env = process.env, options = {}) {
  const requireDatabase = options.requireDatabase !== false;
  const requireSession = options.requireSession !== false;
  const requireYingdao = options.requireYingdao !== false;
  const validateApplication = options.validateApplication !== false;
  const nodeEnv = textValue(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const databaseUrl = resolveDatabaseUrl(env, { required: requireDatabase });
  const parsedDatabaseUrl = parseDatabaseUrl(databaseUrl);
  const databaseSsl = resolveDatabaseSsl(env, parsedDatabaseUrl);
  const databaseApplicationName = resolveDatabaseApplicationName(env, parsedDatabaseUrl);

  const authMode = textValue(env, 'AUTH_MODE', 'dev').toLowerCase();
  if (!['dev', 'feishu'].includes(authMode)) {
    throw new ConfigError('AUTH_MODE must be dev or feishu', 'AUTH_MODE');
  }
  const allowDevAuthInProduction = booleanValue(env, 'ALLOW_DEV_AUTH_IN_PRODUCTION', false);
  if (validateApplication && isProduction && authMode === 'dev' && !allowDevAuthInProduction) {
    throw new ConfigError(
      'AUTH_MODE=dev is disabled in production unless ALLOW_DEV_AUTH_IN_PRODUCTION=true',
      'AUTH_MODE'
    );
  }

  const cors = resolveCorsConfig(env, { isProduction, validateApplication });

  const sessionSecret = requireSession
    ? requiredValue(env, 'SESSION_SECRET')
    : textValue(env, 'SESSION_SECRET');
  if (isProduction && sessionSecret && sessionSecret.length < 32) {
    throw new ConfigError('SESSION_SECRET must contain at least 32 characters in production', 'SESSION_SECRET');
  }

  const accessKeyId = requireYingdao
    ? requiredValue(env, 'YINGDAO_ACCESS_KEY_ID')
    : textValue(env, 'YINGDAO_ACCESS_KEY_ID');
  const accessKeySecret = requireYingdao
    ? requiredValue(env, 'YINGDAO_ACCESS_KEY_SECRET')
    : textValue(env, 'YINGDAO_ACCESS_KEY_SECRET');

  return freezeNested({
    nodeEnv,
    isProduction,
    port: positiveInteger(env, 'PORT', 3002, { max: 65535 }),
    cors: {
      origin: cors.origin,
      origins: cors.origins,
      credentials: true,
    },
    database: {
      url: databaseUrl,
      applicationName: databaseApplicationName,
      ssl: databaseSsl,
      maxConnections: positiveInteger(env, 'PGPOOL_MAX', 10, { max: 100 }),
      idleTimeoutMs: positiveInteger(env, 'PGPOOL_IDLE_TIMEOUT_MS', 30000),
      connectionTimeoutMs: positiveInteger(env, 'PGPOOL_CONNECTION_TIMEOUT_MS', 5000),
    },
    auth: {
      mode: authMode,
      allowDevInProduction: allowDevAuthInProduction,
    },
    session: {
      secret: sessionSecret,
      maxAgeSeconds: positiveInteger(env, 'SESSION_MAX_AGE_SECONDS', 28800),
      cookieName: textValue(env, 'SESSION_COOKIE_NAME', 'pytaskgantt.sid'),
      secure: isProduction,
      sameSite: 'lax',
      tableName: 'app_sessions',
    },
    yingdao: {
      accessKeyId,
      accessKeySecret,
      baseUrl: textValue(env, 'YINGDAO_BASE_URL', 'https://api.yingdao.com').replace(/\/$/, ''),
      syncIntervalSeconds: positiveInteger(env, 'YINGDAO_SYNC_INTERVAL_SECONDS', 60),
      scheduleCacheSeconds: positiveInteger(env, 'YINGDAO_SCHEDULE_CACHE_SECONDS', 60),
      bindCacheMaxAgeSeconds: positiveInteger(env, 'YINGDAO_BIND_CACHE_MAX_AGE_SECONDS', 300),
      requestTimeoutMs: positiveInteger(env, 'YINGDAO_REQUEST_TIMEOUT_MS', 15000),
    },
    retention: {
      executionDays: positiveInteger(env, 'EXECUTION_RETENTION_DAYS', 30),
      jobLogCacheSeconds: positiveInteger(env, 'JOB_LOG_CACHE_SECONDS', 300),
    },
    uiRefreshSeconds: positiveInteger(env, 'UI_REFRESH_SECONDS', 10, { min: 5 }),
  });
}

function getConfig(options = {}) {
  loadEnvFile(options.envPath);
  return createConfig(process.env, options);
}

module.exports = {
  ConfigError,
  createConfig,
  getConfig,
  loadEnvFile,
};
