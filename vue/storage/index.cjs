/**
 * 存储后端工厂
 * 按 .env 的 STORAGE_DRIVER 选择实现，对外暴露统一接口：
 *   initStorage() / readTasks() / writeTasks(tasks) / describe()
 *
 * 默认 file（行为与改造前完全一致）；postgres 为可选后端。
 * 仅在选中某 driver 时才 require 其模块，未装 pg 时 file 模式不受影响。
 */

const DRIVER = (process.env.STORAGE_DRIVER || 'file').toLowerCase();

let impl;
switch (DRIVER) {
  case 'postgres':
  case 'pg':
    impl = require('./pgStore.cjs');
    break;
  case 'file':
    impl = require('./fileStore.cjs');
    break;
  default:
    throw new Error(`未知的 STORAGE_DRIVER: ${DRIVER}（可选 file | postgres）`);
}

module.exports = {
  driver: DRIVER,
  initStorage: impl.initStorage,
  readTasks: impl.readTasks,
  saveTasks: impl.saveTasks,       // 增量保存（POST /api/tasks）
  replaceTasks: impl.replaceTasks, // 整体替换（POST /api/import、迁移）
  describe: impl.describe,
};
