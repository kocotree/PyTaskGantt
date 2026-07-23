const path = require('path');
const { getConfig } = require('./server/config.cjs');
const { getPool, closePool } = require('./server/db/pool.cjs');
const { initializeRepositories } = require('./server/db/index.cjs');
const { createRuntime } = require('./server/runtime.cjs');
const { createApp } = require('./server/app.cjs');

let httpServer = null;
let runtime = null;
let shuttingDown = false;

function errorMessage(error) {
  if (error && error.message) return error.message;
  if (error && Array.isArray(error.errors)) return error.errors.map(item => item.message).join('; ');
  return String(error);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在停止服务…`);
  if (runtime) runtime.stopBackground();
  if (httpServer) {
    await new Promise(resolve => httpServer.close(resolve));
  }
  await closePool();
}

async function main() {
  const config = getConfig();
  const pool = getPool(config);
  const { repositories, schema } = await initializeRepositories(pool);
  runtime = createRuntime({ config, pool, repositories, schema, logger: console });
  const app = createApp({
    config: runtime.appConfig,
    pool,
    repositories,
    services: runtime.services,
    staticDir: path.join(__dirname, 'dist'),
    logger: console,
  });

  httpServer = app.listen(config.port, '0.0.0.0', () => {
    console.log(`PyTaskGantt 已启动：http://0.0.0.0:${config.port}`);
    console.log(`PostgreSQL schema version: ${schema.currentVersion}`);
    console.log(`Auth mode: ${config.auth.mode}`);
    runtime.startBackground();
  });
}

process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));

main().catch(async error => {
  console.error(`服务启动失败：${errorMessage(error)}`);
  await shutdown('startup-error');
  process.exit(1);
});
