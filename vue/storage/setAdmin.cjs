#!/usr/bin/env node

const { getConfig } = require('../server/config.cjs');
const { createPool } = require('../server/db/pool.cjs');
const { assertLatestSchema } = require('../server/db/migrations.cjs');

const MAX_BIGINT = 9223372036854775807n;

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (!['--user-id', '--enabled'].includes(argument)) {
      throw new Error(`不支持的参数：${argument}`);
    }
    if (index + 1 >= argv.length) throw new Error(`${argument} 缺少参数值`);
    values[argument] = String(argv[index + 1]).trim();
    index += 1;
  }

  const userId = values['--user-id'] || '';
  if (!/^[1-9]\d*$/.test(userId)) throw new Error('--user-id 必须是精确的内部正整数 ID');
  if (BigInt(userId) > MAX_BIGINT) throw new Error('--user-id 超出 BIGINT 范围');

  const enabledText = values['--enabled'];
  if (!['true', 'false'].includes(enabledText)) {
    throw new Error('--enabled 只接受 true 或 false');
  }
  return { userId, enabled: enabledText === 'true' };
}

async function main({ argv, logger = console.log } = {}) {
  const input = parseArgs(argv);
  const config = getConfig({
    requireSession: false,
    requireYingdao: false,
    validateApplication: false,
  });
  const pool = createPool(config);
  try {
    await assertLatestSchema(pool);
    const { rows } = await pool.query(
      `UPDATE public.app_users
          SET is_admin = $2
        WHERE id = $1
      RETURNING id, display_name, is_admin`,
      [input.userId, input.enabled]
    );
    if (!rows[0]) throw new Error(`用户 ID ${input.userId} 不存在`);
    const result = {
      userId: String(rows[0].id),
      displayName: rows[0].display_name,
      isAdmin: Boolean(rows[0].is_admin),
    };
    logger(`用户 ${result.userId}（${result.displayName}）管理员状态：${result.isAdmin}`);
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`设置管理员失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
