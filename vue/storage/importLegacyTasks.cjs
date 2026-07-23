#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../server/config.cjs');
const { createPool, withTransaction } = require('../server/db/pool.cjs');
const { assertLatestSchema } = require('../server/db/migrations.cjs');
const { normalizeLegacyTasks } = require('./legacyTaskFile.cjs');

function requestedFile(argv = process.argv.slice(2), env = process.env) {
  const flagIndex = argv.indexOf('--file');
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : env.LEGACY_TASKS_FILE;
  if (!value) throw new Error('请通过 --file <path> 或 LEGACY_TASKS_FILE 指定旧 CSV/JSON 文件');
  return path.resolve(process.cwd(), value);
}

async function importLegacyTasks(pool, tasks) {
  return withTransaction(pool, async client => {
    let inserted = 0;
    let skipped = 0;
    for (const task of tasks) {
      const result = task.id == null
        ? await client.query(
          `INSERT INTO public.rpa_tasks (task, start_time, finish_time, bot)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [task.task, task.start, task.finish, task.bot]
        )
        : await client.query(
          `INSERT INTO public.rpa_tasks (id, task, start_time, finish_time, bot)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [task.id, task.task, task.start, task.finish, task.bot]
        );
      if (result.rows[0]) inserted += 1;
      else skipped += 1;
    }

    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('public.rpa_tasks', 'id'),
        CASE WHEN MAX(id) IS NULL THEN 1 ELSE MAX(id) END,
        MAX(id) IS NOT NULL
      )
      FROM public.rpa_tasks
    `);
    return { total: tasks.length, inserted, skipped };
  });
}

async function main() {
  const filePath = requestedFile();
  const content = fs.readFileSync(filePath, 'utf8');
  const tasks = normalizeLegacyTasks(content, path.extname(filePath));
  const config = getConfig({
    requireSession: false,
    requireYingdao: false,
    validateApplication: false,
  });
  const pool = createPool(config);
  try {
    await assertLatestSchema(pool);
    const result = await importLegacyTasks(pool, tasks);
    console.log(
      `旧任务导入完成：读取 ${result.total}，新增 ${result.inserted}，因主键已存在跳过 ${result.skipped}。`
    );
    console.log('导入任务保持 owner_user_id/schedule_uuid 为空，将以历史只读任务显示。');
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`旧任务导入失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  requestedFile,
  normalizeLegacyTasks,
  importLegacyTasks,
  main,
};
