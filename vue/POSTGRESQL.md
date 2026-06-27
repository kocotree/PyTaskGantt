

> 说明：应用支持两种存储后端，由 `.env` 的 `STORAGE_DRIVER` 切换。
> 默认 `file`（读写本地 CSV/JSON 文件，不接触数据库）；本文档仅适用于
> `STORAGE_DRIVER=postgres` 的场景。

---

## 1. 总体概述

- 应用是一个 RPA / 多机器人任务编排的甘特图编辑器，数据模型极简：**单表 `rpa_tasks`，只存当前状态**。
- **无历史、无版本、无软删除**：保存时按主键 `id` 做差异更新（只动新增/修改/删除的行），导入时整体替换。
- **无多租户 / 多项目维度**：全库一份任务列表。
- 应用**不参与任何 DDL**：建表、改表、加索引一律由开发者手动执行（见第 4 节）。
  应用启动时只做一次只读检查（`SELECT to_regclass('public.rpa_tasks')`）确认表存在，缺表即报错退出。
- 数据规模很小：典型几十到几千行，单行约 100~200 字节，整表通常 < 1 MB。

---

## 2. 连接配置

应用通过 `.env`（不入库）读取连接信息，二选一：

| 方式 | 变量 | 示例 |
|------|------|------|
| 连接串（优先） | `DATABASE_URL` | `postgresql://app_user:secret@db-host:5432/pytaskgantt` |
| 分散变量 | `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | 标准 libpq 环境变量 |

- 驱动：Node.js [`pg`](https://node-postgres.com/)（连接池 `Pool`，默认池大小 10）。
- Schema：固定使用 `public.rpa_tasks`。
- 字符集：库需支持 UTF-8（任务名 / 机器人名含中文）。建议 `ENCODING 'UTF8'`。
- 若用 `localhost`，注意 Node 会同时尝试 `::1` 与 `127.0.0.1`；请确保 `pg_hba.conf` 对实际使用的地址放行。

---

## 3. 表结构

应用对数据库的全部结构需求就是下面这一张表（与随仓库提供的 `storage/schema.sql` 完全一致）：

```sql
CREATE TABLE IF NOT EXISTS rpa_tasks (
  id          INTEGER     PRIMARY KEY,
  task        TEXT        NOT NULL,
  start_time  VARCHAR(8)  NOT NULL DEFAULT '00:00:00',
  finish_time VARCHAR(8)  NOT NULL DEFAULT '00:00:00',
  bot         TEXT        NOT NULL DEFAULT '未分类'
);

CREATE INDEX IF NOT EXISTS idx_rpa_tasks_bot ON rpa_tasks (bot);
```

### 字段语义

| 列 | 类型 | 约束 | 说明 |
|----|------|------|------|
| `id` | `INTEGER` | 主键 | 任务序号。**由应用层分配**（创建后保持稳定，保存据此做增量比对），**非数据库自增**。故用普通 `INTEGER` 而非 `SERIAL`。 |
| `task` | `TEXT` | `NOT NULL` | 任务名称（含中文），如「数据同步 #1」。 |
| `start_time` | `VARCHAR(8)` | `NOT NULL` | 开始时间，固定格式 `HH:MM:SS`（24 小时制）。 |
| `finish_time` | `VARCHAR(8)` | `NOT NULL` | 结束时间，格式同上。 |
| `bot` | `TEXT` | `NOT NULL` | 机器人 / 分类名（含中文）。**无固定枚举**，由数据驱动。 |

### 关键数据语义（务必了解，影响理解与排障）

1. **时间是字符串标签，不是真实时间戳。** 用 `VARCHAR(8)` 存原始 `HH:MM:SS` 字符串，
   做到零转换、完全保真，而非 `TIME` / `TIMESTAMP`。
2. **跨天任务靠 `finish_time < start_time` 判断**（字符串比较即可，因格式定长）。例如
   `start='23:00:00'`、`finish='01:00:00'` 表示从当天 23:00 跨越午夜到次日 01:00。
   数据库**不做**任何时间运算，跨天逻辑全在前端处理。
3. **`id` 是保存路径的稳定主键。** 任务一旦创建，其 `id` 在后续编辑/保存中保持不变，
   应用据此做增量差异更新。读取时按 `ORDER BY id` 取回。
   （例外：**导入** CSV/JSON 是整体替换，会用导入数据的行号重新编号——这是替换语义，不是增量。）
4. **`bot` 无枚举表**，新任务可填任意机器人名。

---

## 4. 建表与初始化流程

应用**不会自动建表**。上线前请手动完成：

```bash
# 1. 创建数据库（按需）
createdb -E UTF8 pytaskgantt

# 2. 执行建表脚本（随仓库提供）
psql "postgresql://app_user:secret@db-host:5432/pytaskgantt" -f storage/schema.sql

# 3.（可选）把现有文件数据一次性迁入数据库
#    在 vue/ 目录、配好 .env（STORAGE_DRIVER 可临时仍为 file）后执行：
npm run migrate:pg
```

`npm run migrate:pg`（即 `node storage/migrate.cjs`）的行为：读取 `TASKS_FILE` 指定的
CSV/JSON → 校验 `rpa_tasks` 表存在（不建表）→ 整表写入。**只读文件、写库，不建表、不删文件。**

完成后把应用 `.env` 设为 `STORAGE_DRIVER=postgres` 并重启即可。

---

## 5. 应用对数据库的访问模式

应用仅有以下 4 个 HTTP 端点会触达数据库，对应 SQL 如下：

| 端点 | 触发动作 | 实际 SQL |
|------|----------|----------|
| `GET /api/tasks` | 加载 / 刷新 | `SELECT id, task, start_time AS start, finish_time AS finish, bot FROM rpa_tasks ORDER BY id` |
| `POST /api/tasks` | 用户点「保存」 | **增量差异更新**（见 5.1） |
| `POST /api/import` | 导入 CSV/JSON | **整体替换**（见 5.2） |
| `GET /api/export/:format` | 导出 | 同 `GET /api/tasks` 的 `SELECT`，结果转 CSV/JSON 返回 |

> 注：每次「加载 / 刷新」都直接 `SELECT` 查库，应用层不做缓存——理由见第 7 节。

### 5.1 保存：增量差异更新（写路径，常用）

保存时应用拿到前端全量任务（每条带稳定主键 `id`），先读库内现状，按 `id` 做差异比对，
**在单个事务内只对受影响的行动手**：

```sql
BEGIN;
-- 先读现状用于比对
SELECT id, task, start_time, finish_time, bot FROM rpa_tasks;

-- 传入有、库内无 → 新增
INSERT INTO rpa_tasks (id, task, start_time, finish_time, bot) VALUES ($1, $2, $3, $4, $5);
-- 两边都有但字段有变 → 更新（完全一致的行跳过，不产生写）
UPDATE rpa_tasks SET task = $2, start_time = $3, finish_time = $4, bot = $5 WHERE id = $1;
-- 库内有、传入无 → 删除
DELETE FROM rpa_tasks WHERE id = ANY($1::int[]);
COMMIT;   -- 出错则 ROLLBACK
```

- **不做整表清空**，不锁全表；未变化的行完全不触碰。
- 失败自动 `ROLLBACK`，不会留下半截数据。
- 数据规模小（通常几十~几千行），逐行 INSERT/UPDATE 足够，无性能顾虑。

### 5.2 导入 / 迁移：整体替换

导入文件（或首次迁移）语义是「用这份数据完全替换现有数据」，导入数据的 `id` 与库内无对应关系，
故清空后批量重写，同样在单个事务内：

```sql
BEGIN;
DELETE FROM rpa_tasks;
INSERT INTO rpa_tasks (id, task, start_time, finish_time, bot)
SELECT * FROM unnest($1::int[], $2::text[], $3::varchar[], $4::varchar[], $5::text[]);
COMMIT;   -- 出错则 ROLLBACK
```

- 用 `DELETE` 而非 `TRUNCATE`：行级、MVCC 友好，**不取 `ACCESS EXCLUSIVE` 锁，也不需要额外的 `TRUNCATE` 权限**。
- 仅在显式导入 / 迁移时触发，属低频操作。

---

## 6. 权限需求

应用所用数据库角色（如 `app_user`）需要对 `public.rpa_tasks` 具备常规增删改查权限：

| 权限 | 用途 |
|------|------|
| `SELECT` | 读取任务、保存前的差异比对、导出 |
| `INSERT` | 新增任务 / 导入批量插入 |
| `UPDATE` | 增量更新已有任务 |
| `DELETE` | 删除任务 / 导入时清空旧数据 |

授权示例：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rpa_tasks TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
```

- **不需要 `TRUNCATE` 权限**（清空用 `DELETE`）。
- 应用**不需要** DDL 权限（`CREATE` / `ALTER` / `DROP`），建表交接给数据库管理方。
- 不使用序列、触发器、存储过程、扩展。

---

## 7. 数据读取策略：直查数据库，不做应用层缓存

应用每次「加载 / 刷新」都直接 `SELECT` 查库，**有意不加应用层缓存**，原因：

- **数据小、查询快**：单表通常几十~几千行（< 1 MB），全表 `SELECT` 为微秒~毫秒级；PostgreSQL
  的 `shared_buffers` 本就把这类热表常驻内存，再加一层应用缓存收益微乎其微。
- **访问低频**：编辑器为单用户 / 小团队使用，打开与刷新频率低，远未触及数据库瓶颈。
- **一致性优先**：多人编辑时，缓存会让客户端读到过期数据；直查保证每次拿到最新真相。

> 何时才需要引入缓存：出现高 QPS（每秒成百上千读）或昂贵的大表聚合查询时。本应用均不满足，
> 故保持直查最简单也最稳妥（符合 KISS / YAGNI）。届时也应优先依赖数据库自身缓存与索引，
> 应用层缓存放到最后且须配套失效机制。
