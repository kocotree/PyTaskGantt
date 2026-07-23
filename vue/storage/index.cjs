/**
 * Transitional PostgreSQL-only storage facade.
 *
 * New code should use server/db directly. These exports keep the old startup
 * module loadable while making destructive full-table save/import paths fail
 * explicitly instead of silently overwriting another user's data.
 */

const { getConfig } = require('../server/config.cjs');
const { getPool } = require('../server/db/pool.cjs');
const { initializeRepositories } = require('../server/db/index.cjs');

let pool = null;
let repositories = null;
let schemaState = null;

async function initStorage() {
  const config = getConfig({
    requireSession: false,
    requireYingdao: false,
    validateApplication: false,
  });
  pool = getPool(config);
  const initialized = await initializeRepositories(pool);
  repositories = initialized.repositories;
  schemaState = initialized.schema;
  return schemaState;
}

function requireInitialized() {
  if (!repositories) throw new Error('PostgreSQL storage has not been initialized');
  return repositories;
}

async function readTasks() {
  // Compatibility only: user id 0 cannot own a real BIGINT identity row, so all
  // returned tasks are read-only. Authenticated routes should call listAll(userId).
  return requireInitialized().tasks.listAll('0');
}

function fullTableMutationDisabled() {
  const error = new Error(
    'Full-table task writes are disabled. Use the authenticated mutation batch API.'
  );
  error.code = 'LEGACY_FULL_TABLE_WRITE_DISABLED';
  error.status = 410;
  throw error;
}

async function saveTasks() {
  return fullTableMutationDisabled();
}

async function replaceTasks() {
  return fullTableMutationDisabled();
}

function getRepositories() {
  return requireInitialized();
}

function describe() {
  return `postgres (schema version ${schemaState ? schemaState.currentVersion : 'unverified'})`;
}

module.exports = {
  driver: 'postgres',
  initStorage,
  readTasks,
  saveTasks,
  replaceTasks,
  getRepositories,
  describe,
};
