const { spawnSync } = require('node:child_process');
const path = require('node:path');

const databaseUrl = String(process.env.TEST_DATABASE_URL || '').trim();

if (!databaseUrl) {
  console.error('缺少 TEST_DATABASE_URL，PostgreSQL 集成测试未运行。');
  console.error('请将它指向已完成迁移、允许测试清空数据的专用隔离数据库；严禁使用开发、共享或生产数据库。');
  process.exit(1);
}

const vitestDirectory = path.dirname(require.resolve('vitest/package.json'));
const result = spawnSync(
  process.execPath,
  [path.join(vitestDirectory, 'vitest.mjs'), 'run', 'test/backend-postgres.integration.test.cjs'],
  {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(`PostgreSQL 集成测试启动失败：${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`PostgreSQL 集成测试被信号 ${result.signal} 中止。`);
  process.exit(1);
}

process.exit(result.status ?? 1);
