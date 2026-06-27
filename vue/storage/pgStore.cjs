/**
 * PostgreSQL 存储后端（可选）
 * 仅在 STORAGE_DRIVER=postgres 时被 storage/index.cjs 加载。
 *
 * 设计约束：
 *  - 只存当前状态（单表 rpa_tasks），无历史 / 版本。
 *  - 不参与 DDL：启动只做「表是否存在」的只读检查，缺表时给清晰提示，
 *    建表由用户手动执行 storage/schema.sql。
 *  - 整表覆盖（writeTasks）用事务内 TRUNCATE + 批量 INSERT，精确复刻文件版语义。
 *
 * 连接配置（来自 .env）：优先 DATABASE_URL；否则回落到标准 PG* 环境变量
 * （PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD，由 pg 自动识别）。
 */

// 懒加载 pg：未安装时给出可读的安装提示，而非晦涩的模块缺失栈
let Pool;
try {
  ({ Pool } = require('pg'));
} catch (err) {
  throw new Error('STORAGE_DRIVER=postgres 需要 pg 依赖，请先执行 npm install pg');
}

const TABLE = 'rpa_tasks';

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool(); // 回落到标准 PG* 环境变量

async function initStorage() {
  // 不建表，只校验连通性与表是否存在
  const { rows } = await pool.query("SELECT to_regclass('public.' || $1) AS reg", [TABLE]);
  if (!rows[0] || rows[0].reg === null) {
    throw new Error(
      `PostgreSQL 中不存在表 "${TABLE}"。请先手动执行 storage/schema.sql 建表后再启动。`
    );
  }
}

async function readTasks() {
  const { rows } = await pool.query(
    `SELECT id, task, start_time AS start, finish_time AS finish, bot
     FROM ${TABLE} ORDER BY id`
  );
  return rows;
}

/**
 * 增量保存（用户点「保存」走这里）
 * 以稳定的 id 为键，与库内现状做差异比对，只对受影响的行动手：
 *   - 传入有、库内无         → INSERT
 *   - 两边都有但字段有变化   → UPDATE
 *   - 两边都有且完全一致     → 跳过（不产生写）
 *   - 库内有、传入无         → DELETE
 * 全程单事务，出错回滚。数据规模小，逐行处理足够清晰高效。
 */
async function saveTasks(tasks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT id, task, start_time, finish_time, bot FROM ${TABLE}`
    );
    const existingById = new Map(existing.map(r => [r.id, r]));
    const incomingIds = new Set();
    let inserted = 0, updated = 0, deleted = 0;

    for (const t of tasks) {
      const id = t.id;
      incomingIds.add(id);
      const cur = existingById.get(id);
      if (!cur) {
        await client.query(
          `INSERT INTO ${TABLE} (id, task, start_time, finish_time, bot)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, t.task, t.start, t.finish, t.bot]
        );
        inserted++;
      } else if (
        cur.task !== t.task ||
        cur.start_time !== t.start ||
        cur.finish_time !== t.finish ||
        cur.bot !== t.bot
      ) {
        await client.query(
          `UPDATE ${TABLE} SET task = $2, start_time = $3, finish_time = $4, bot = $5
           WHERE id = $1`,
          [id, t.task, t.start, t.finish, t.bot]
        );
        updated++;
      }
      // 未变化则跳过
    }

    const toDelete = existing.filter(r => !incomingIds.has(r.id)).map(r => r.id);
    if (toDelete.length > 0) {
      await client.query(`DELETE FROM ${TABLE} WHERE id = ANY($1::int[])`, [toDelete]);
      deleted = toDelete.length;
    }

    await client.query('COMMIT');
    return { inserted, updated, deleted, total: tasks.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 整体替换（导入 / 迁移走这里）
 * 语义为「用这批数据完全替换现有数据」，故清空后批量写入。
 * 用 DELETE 而非 TRUNCATE：行级、MVCC 友好，不取 ACCESS EXCLUSIVE 锁，
 * 也无需额外的 TRUNCATE 权限。全程单事务。
 */
async function replaceTasks(tasks) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${TABLE}`);

    if (tasks.length > 0) {
      // unnest 多数组批量插入，一条语句写入全部行
      const ids = tasks.map((t, i) => t.id || i + 1);
      const names = tasks.map(t => t.task);
      const starts = tasks.map(t => t.start);
      const finishes = tasks.map(t => t.finish);
      const bots = tasks.map(t => t.bot);

      await client.query(
        `INSERT INTO ${TABLE} (id, task, start_time, finish_time, bot)
         SELECT * FROM unnest($1::int[], $2::text[], $3::varchar[], $4::varchar[], $5::text[])`,
        [ids, names, starts, finishes, bots]
      );
    }

    await client.query('COMMIT');
    return tasks.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function describe() {
  const target = process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@')
    : `${process.env.PGHOST || 'localhost'}/${process.env.PGDATABASE || ''}`;
  return `postgres: ${target} (table: ${TABLE})`;
}

module.exports = { initStorage, readTasks, saveTasks, replaceTasks, describe };
