const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmod, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const backupScript = path.join(projectRoot, 'storage/operations/backup.sh');
const rollbackScript = path.join(projectRoot, 'storage/operations/rollback.sh');
const grantRuntimeRoleScript = path.join(projectRoot, 'storage/operations/grant-runtime-role.sql');
const verifyRuntimeRoleScript = path.join(projectRoot, 'storage/operations/verify-runtime-role.sql');
const connectionKeys = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
];

function isolatedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of connectionKeys) delete env[key];
  return { ...env, ...overrides };
}

async function createFakeClient(directory, name, body) {
  const clientPath = path.join(directory, name);
  await writeFile(clientPath, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
  await chmod(clientPath, 0o755);
  return clientPath;
}

test('operation scripts keep connection strings out of PostgreSQL client argv', async () => {
  for (const scriptPath of [backupScript, rollbackScript]) {
    const source = await readFile(scriptPath, 'utf8');
    assert.doesNotMatch(source, /--dbname(?:=|\s).*DATABASE_URL/);
    assert.match(source, /PGDATABASE="\$DATABASE_URL"/);
  }

  assert.match(await readFile(backupScript, 'utf8'), /^umask 077$/m);
  const rollbackSource = await readFile(rollbackScript, 'utf8');
  assert.match(rollbackSource, /^\s*--dbname= \\$/m);
  assert.match(rollbackSource, /^\s*--single-transaction \\$/m);
});

test('runtime-role scripts grant only the repository operations and verify effective privileges', async () => {
  const grantSource = await readFile(grantRuntimeRoleScript, 'utf8');
  const verifySource = await readFile(verifyRuntimeRoleScript, 'utf8');

  assert.match(grantSource, /ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(grantSource, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(grantSource, /GRANT SELECT ON TABLE public\.schema_migrations/);
  assert.match(grantSource, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.rpa_task_executions/);
  assert.match(grantSource, /GRANT SELECT, INSERT ON TABLE public\.rpa_task_audit_log/);
  assert.match(grantSource, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.app_sessions/);
  assert.match(grantSource, /GRANT USAGE ON SEQUENCE/);
  assert.match(grantSource, /\\ir verify-runtime-role\.sql/);
  assert.doesNotMatch(grantSource, /GRANT[^;]+ON ALL TABLES/is);
  assert.doesNotMatch(grantSource, /ALTER DEFAULT PRIVILEGES/i);
  assert.doesNotMatch(grantSource, /GRANT ALL/i);

  assert.match(verifySource, /SET TRANSACTION READ ONLY/);
  assert.match(verifySource, /has_table_privilege/);
  assert.match(verifySource, /has_sequence_privilege/);
  assert.match(verifySource, /pg_auth_members/);
  assert.match(verifySource, /has_database_privilege/);
});

test('backup passes DATABASE_URL through PGDATABASE and creates a private file', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pytaskgantt-backup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const argsFile = path.join(directory, 'args.txt');
  const envFile = path.join(directory, 'env.txt');
  const backupFile = path.join(directory, 'before-upgrade.dump');
  await createFakeClient(directory, 'pg_dump', `
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
printf '%s\\n%s' "\${PGDATABASE:-}" "\${DATABASE_URL:-}" > "$CAPTURE_ENV"
output_file=
for arg in "$@"; do
  case "$arg" in
    --file=*) output_file=\${arg#--file=} ;;
  esac
done
: > "$output_file"
`);

  const databaseUrl = 'postgresql://app:super-secret@db.example:5432/tasks';
  const result = spawnSync(backupScript, [backupFile], {
    encoding: 'utf8',
    env: isolatedEnv({
      DATABASE_URL: databaseUrl,
      PATH: `${directory}:${process.env.PATH || ''}`,
      CAPTURE_ARGS: argsFile,
      CAPTURE_ENV: envFile,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  assert.deepEqual(args, ['--format=custom', `--file=${backupFile}`]);
  assert.equal(args.some(arg => arg.includes(databaseUrl)), false);
  assert.equal(await readFile(envFile, 'utf8'), `${databaseUrl}\n`);
  assert.equal((await stat(backupFile)).mode & 0o777, 0o600);
});

test('rollback accepts complete PG variables and restores directly in one transaction', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pytaskgantt-rollback-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const argsFile = path.join(directory, 'args.txt');
  const envFile = path.join(directory, 'env.txt');
  const backupFile = path.join(directory, 'before-upgrade.dump');
  await writeFile(backupFile, 'test backup');
  await createFakeClient(directory, 'pg_restore', `
printf '%s\\n' "$@" > "$CAPTURE_ARGS"
printf '%s\\n%s\\n%s\\n%s\\n%s' \
  "\${PGHOST:-}" "\${PGPORT:-}" "\${PGDATABASE:-}" "\${PGUSER:-}" "\${PGPASSWORD:-}" > "$CAPTURE_ENV"
`);

  const result = spawnSync(rollbackScript, [backupFile], {
    encoding: 'utf8',
    env: isolatedEnv({
      PGHOST: 'db.internal',
      PGPORT: '5432',
      PGDATABASE: 'tasks',
      PGUSER: 'restore_user',
      PGPASSWORD: 'split-variable-secret',
      CONFIRM_RESTORE: 'RESTORE_BACKUP',
      PATH: `${directory}:${process.env.PATH || ''}`,
      CAPTURE_ARGS: argsFile,
      CAPTURE_ENV: envFile,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
  assert.deepEqual(args, [
    '--dbname=',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--exit-on-error',
    '--single-transaction',
    backupFile,
  ]);
  assert.equal(args.some(arg => arg.includes('split-variable-secret')), false);
  assert.equal(
    await readFile(envFile, 'utf8'),
    'db.internal\n5432\ntasks\nrestore_user\nsplit-variable-secret'
  );
});

test('operation scripts retain absolute-path and destructive-restore safeguards', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pytaskgantt-ops-safety-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const env = isolatedEnv({
    PGHOST: 'db.internal',
    PGPORT: '5432',
    PGDATABASE: 'tasks',
    PGUSER: 'operator',
    PGPASSWORD: 'test-secret',
  });
  const relativeBackup = path.join(directory, 'relative.dump');
  await writeFile(relativeBackup, 'test backup');

  const backupResult = spawnSync(backupScript, ['relative.dump'], {
    cwd: directory,
    encoding: 'utf8',
    env,
  });
  assert.notEqual(backupResult.status, 0);
  assert.match(backupResult.stderr, /Backup path must be absolute/);

  const rollbackResult = spawnSync(rollbackScript, [relativeBackup], {
    encoding: 'utf8',
    env,
  });
  assert.notEqual(rollbackResult.status, 0);
  assert.match(rollbackResult.stderr, /CONFIRM_RESTORE=RESTORE_BACKUP/);
});
