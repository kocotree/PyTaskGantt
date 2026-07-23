#!/usr/bin/env node

const { getConfig } = require('../server/config.cjs');
const { createPool } = require('../server/db/pool.cjs');
const { applyPendingMigrations } = require('../server/db/migrations.cjs');

function sanitizeErrorText(value) {
  return String(value || '')
    .replace(/\b(postgres(?:ql)?:\/\/)([^@\s]+)@/gi, '$1<credentials>@')
    .replace(/\b(password|pwd)=([^\s;]+)/gi, '$1=<redacted>');
}

function describeErrorItem(error) {
  if (error == null) return '';
  if (typeof error !== 'object') return sanitizeErrorText(error).trim();

  const code = sanitizeErrorText(error.code).trim();
  const message = sanitizeErrorText(error.message).trim();
  const name = sanitizeErrorText(error.name).trim();
  const detail = message || name || 'Unknown error';
  return code ? `[${code}] ${detail}` : detail;
}

function describeError(error) {
  const nested = error && Array.isArray(error.errors) ? error.errors : [];
  const candidates = nested.length > 0 ? nested : [error];
  const descriptions = candidates.map(describeErrorItem).filter(Boolean);
  return [...new Set(descriptions)].join('; ') || 'Unknown error';
}

async function main({ logger = console.log, errorLogger = console.error } = {}) {
  let pool;
  try {
    const config = getConfig({
      requireSession: false,
      requireYingdao: false,
      validateApplication: false,
    });
    pool = createPool(config);
    const result = await applyPendingMigrations(pool, {
      logger: message => logger(`[migration] ${message}`),
    });
    if (result.executed.length === 0) {
      logger(`Database schema is already current (version ${result.currentVersion}).`);
    } else {
      logger(`Applied ${result.executed.length} migration(s); schema version is now ${result.currentVersion}.`);
    }
    return result;
  } catch (error) {
    const migration = error && error.migration ? ` (${error.migration})` : '';
    errorLogger(`Database migration failed${migration}: ${describeError(error)}`);
    throw error;
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = { describeError, main, sanitizeErrorText };
