-- PyTaskGantt PostgreSQL 建表脚本（参考用）
--
-- 注意：应用本身不会自动建表。请在目标库手动执行本脚本后，
-- 再把 .env 的 STORAGE_DRIVER 设为 postgres 并配置连接信息。
--
-- 用法示例：
--   psql "$DATABASE_URL" -f storage/schema.sql

CREATE TABLE IF NOT EXISTS rpa_tasks (
  id          INTEGER     PRIMARY KEY,
  task        TEXT        NOT NULL,
  start_time  VARCHAR(8)  NOT NULL DEFAULT '00:00:00',  -- HH:MM:SS 原样存储
  finish_time VARCHAR(8)  NOT NULL DEFAULT '00:00:00',  -- 跨天靠 finish<start 判断，不做时间运算
  bot         TEXT        NOT NULL DEFAULT '未分类'
);

CREATE INDEX IF NOT EXISTS idx_rpa_tasks_bot ON rpa_tasks (bot);
