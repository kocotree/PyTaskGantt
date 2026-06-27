/**
 * 一次性迁移脚本：把现有文件数据（TASKS_FILE）灌入 PostgreSQL。
 *
 *   node storage/migrate.cjs   （或 npm run migrate:pg）
 *
 * 行为：读文件源（fileStore）→ 校验 PG 表存在（pgStore，不建表）→ 整表写入。
 * 只读文件、写 DB，不建表、不删文件。要求 .env 已配好 PostgreSQL 连接信息，
 * 且目标库已手动执行 storage/schema.sql 建好 tasks 表。
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fileStore = require('./fileStore.cjs');
const pgStore = require('./pgStore.cjs');

(async () => {
  try {
    console.log(`📖 读取文件源: ${fileStore.describe()}`);
    const tasks = await fileStore.readTasks();
    console.log(`   读到 ${tasks.length} 条任务`);

    console.log(`🔌 连接目标库: ${pgStore.describe()}`);
    await pgStore.initStorage(); // 仅校验表存在，缺表会抛出清晰提示

    const count = await pgStore.replaceTasks(tasks);
    console.log(`✅ 迁移完成：已写入 ${count} 条任务到 PostgreSQL`);
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ 迁移失败: ${error.message}\n`);
    process.exit(1);
  }
})();
