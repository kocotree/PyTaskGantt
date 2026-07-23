const { assertLatestSchema } = require('./migrations.cjs');
const { createUsersRepository } = require('./usersRepository.cjs');
const { createTasksRepository } = require('./tasksRepository.cjs');
const { createExecutionsRepository } = require('./executionsRepository.cjs');
const { createAuditRepository } = require('./auditRepository.cjs');
const { createRunRequestsRepository } = require('./runRequestsRepository.cjs');

function createRepositories(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');
  const users = createUsersRepository(db);
  const nativeTasks = createTasksRepository(db);
  const executions = createExecutionsRepository(db);
  const audit = createAuditRepository(db);
  const runRequests = createRunRequestsRepository(db);

  // Compatibility aliases keep route/bootstrap code concise while preserving
  // the domain-specific repository exports for services and tests.
  const tasks = Object.freeze({
    ...nativeTasks,
    listExecutions: (taskId, pagination = {}, options = {}) =>
      executions.listForTask(taskId, pagination, options),
    listExecutionsPage: (taskId, pagination = {}, options = {}) =>
      executions.listForTaskPage(taskId, pagination, options),
  });

  async function healthCheck() {
    const { rows } = await db.query('SELECT NOW() AS database_time');
    return {
      ok: true,
      databaseTime: rows[0] && rows[0].database_time,
    };
  }

  return Object.freeze({ users, tasks, executions, audit, runRequests, healthCheck });
}

async function verifyDatabase(db, options = {}) {
  await db.query('SELECT 1');
  return assertLatestSchema(db, options);
}

async function initializeRepositories(db, options = {}) {
  const schema = await verifyDatabase(db, options);
  return { repositories: createRepositories(db), schema };
}

module.exports = {
  createRepositories,
  verifyDatabase,
  initializeRepositories,
};
