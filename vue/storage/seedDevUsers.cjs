const { getConfig } = require('../server/config.cjs');
const { createPool } = require('../server/db/pool.cjs');
const { assertLatestSchema } = require('../server/db/migrations.cjs');

function requestedNames() {
  const cliNames = process.argv.slice(2);
  const envNames = String(process.env.DEV_USER_NAMES || '').split(',');
  return [...new Set([...cliNames, ...envNames].map(value => value.trim()).filter(Boolean))];
}

async function main() {
  const names = requestedNames();
  if (names.length === 0) {
    throw new Error('请通过命令参数或 DEV_USER_NAMES 提供至少一个开发用户名称');
  }
  const config = getConfig({ requireSession: false, requireYingdao: false });
  if (config.auth.mode !== 'dev') throw new Error('只有 AUTH_MODE=dev 才能创建开发用户');
  const pool = createPool(config);
  try {
    await assertLatestSchema(pool);
    for (const displayName of names) {
      const { rows } = await pool.query(
        `SELECT id FROM app_users
         WHERE auth_provider = 'dev' AND display_name = $1
         ORDER BY id LIMIT 1`,
        [displayName]
      );
      if (rows[0]) {
        console.log(`已存在：${displayName} (id=${rows[0].id})`);
        continue;
      }
      const inserted = await pool.query(
        `INSERT INTO app_users (display_name, auth_provider)
         VALUES ($1, 'dev') RETURNING id`,
        [displayName]
      );
      console.log(`已创建：${displayName} (id=${inserted.rows[0].id})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(`创建开发用户失败：${error.message}`);
  process.exit(1);
});
