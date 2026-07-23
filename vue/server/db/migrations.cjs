const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'storage', 'migrations');
const EXPECTED_LATEST_VERSION = 6;
const MIGRATION_LOCK_KEY = 1876249127;

class MigrationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    Object.assign(this, details);
  }
}

function checksumSql(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function discoverMigrations(directory = DEFAULT_MIGRATIONS_DIR) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{3}_[a-z0-9_]+\.sql$/i.test(entry.name))
    .map(entry => {
      const version = Number(entry.name.slice(0, 3));
      const filePath = path.join(directory, entry.name);
      const sql = fs.readFileSync(filePath, 'utf8');
      return {
        version,
        name: entry.name,
        path: filePath,
        sql,
        checksum: checksumSql(sql),
      };
    })
    .sort((a, b) => a.version - b.version);

  if (entries.length === 0) {
    throw new MigrationError(`No migrations found in ${directory}`, 'NO_MIGRATIONS');
  }
  const seen = new Set();
  entries.forEach((migration, index) => {
    const expected = index + 1;
    if (seen.has(migration.version)) {
      throw new MigrationError(`Duplicate migration version ${migration.version}`, 'DUPLICATE_MIGRATION');
    }
    seen.add(migration.version);
    if (migration.version !== expected) {
      throw new MigrationError(
        `Migration sequence is not contiguous: expected ${expected}, found ${migration.version}`,
        'MIGRATION_GAP'
      );
    }
  });
  if (entries.at(-1).version !== EXPECTED_LATEST_VERSION) {
    throw new MigrationError(
      `Expected schema version ${EXPECTED_LATEST_VERSION}, found ${entries.at(-1).version}`,
      'UNEXPECTED_LATEST_VERSION'
    );
  }
  return entries;
}

async function schemaMigrationsTableExists(queryable) {
  const { rows } = await queryable.query(
    "SELECT to_regclass('public.schema_migrations') AS table_name"
  );
  return Boolean(rows[0] && rows[0].table_name);
}

async function readAppliedMigrations(queryable) {
  if (!(await schemaMigrationsTableExists(queryable))) return null;
  const { rows } = await queryable.query(
    `SELECT version, name, checksum, applied_at
       FROM public.schema_migrations
      ORDER BY version`
  );
  return rows.map(row => ({
    version: Number(row.version),
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

function compareMigrationState(expected, applied) {
  if (applied == null) {
    throw new MigrationError(
      'Database schema is not initialized. Run `node storage/migrate.cjs`.',
      'SCHEMA_NOT_INITIALIZED'
    );
  }
  const expectedByVersion = new Map(expected.map(item => [item.version, item]));
  const appliedByVersion = new Map(applied.map(item => [item.version, item]));

  for (const row of applied) {
    const migration = expectedByVersion.get(row.version);
    if (!migration) {
      throw new MigrationError(
        `Database schema version ${row.version} is newer than this application supports`,
        'SCHEMA_TOO_NEW',
        { currentVersion: row.version, latestVersion: expected.at(-1).version }
      );
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new MigrationError(
        `Migration ${migration.name} differs from the version recorded by the database`,
        'MIGRATION_CHECKSUM_MISMATCH',
        { version: migration.version }
      );
    }
  }

  const missing = expected.filter(item => !appliedByVersion.has(item.version));
  if (missing.length > 0) {
    throw new MigrationError(
      `Database schema is behind. Missing: ${missing.map(item => item.name).join(', ')}`,
      'SCHEMA_OUTDATED',
      {
        currentVersion: applied.length ? Math.max(...applied.map(item => item.version)) : 0,
        latestVersion: expected.at(-1).version,
        missing: missing.map(item => item.name),
      }
    );
  }
  return {
    currentVersion: expected.at(-1).version,
    latestVersion: expected.at(-1).version,
    applied: applied.length,
  };
}

/** Read-only startup gate. This function never creates or alters database objects. */
async function assertLatestSchema(queryable, options = {}) {
  const migrations = options.migrations || discoverMigrations(options.directory);
  const applied = await readAppliedMigrations(queryable);
  return compareMigrationState(migrations, applied);
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/** Manual migration operation. Each numbered migration is committed atomically. */
async function applyPendingMigrations(pool, options = {}) {
  const migrations = options.migrations || discoverMigrations(options.directory);
  const logger = options.logger || (() => {});
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    await ensureMigrationTable(client);
    const applied = await readAppliedMigrations(client);

    // Refuse rewritten or unknown history before applying anything new.
    const knownApplied = applied || [];
    const expectedByVersion = new Map(migrations.map(item => [item.version, item]));
    for (const [index, row] of knownApplied.entries()) {
      if (row.version !== index + 1) {
        throw new MigrationError(
          `Database migration history has a gap before version ${row.version}`,
          'MIGRATION_HISTORY_GAP',
          { version: row.version }
        );
      }
      const expected = expectedByVersion.get(row.version);
      if (!expected) {
        throw new MigrationError(
          `Database contains unsupported migration version ${row.version}`,
          'SCHEMA_TOO_NEW'
        );
      }
      if (row.name !== expected.name || row.checksum !== expected.checksum) {
        throw new MigrationError(
          `Migration ${expected.name} checksum does not match database history`,
          'MIGRATION_CHECKSUM_MISMATCH',
          { version: expected.version }
        );
      }
    }

    const appliedVersions = new Set(knownApplied.map(item => item.version));
    const executed = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      logger(`Applying ${migration.name}`);
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO public.schema_migrations (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, migration.checksum]
        );
        await client.query('COMMIT');
        executed.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        error.migration = migration.name;
        throw error;
      }
    }
    const state = await assertLatestSchema(client, { migrations });
    return { ...state, executed };
  } finally {
    if (lockHeld) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch (_) {
        // The session ending also releases the lock.
      }
    }
    client.release();
  }
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  EXPECTED_LATEST_VERSION,
  MigrationError,
  checksumSql,
  discoverMigrations,
  readAppliedMigrations,
  compareMigrationState,
  assertLatestSchema,
  applyPendingMigrations,
};
