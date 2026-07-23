# PostgreSQL 运行、迁移与运维说明

PyTaskGantt 只使用 PostgreSQL 作为运行时数据源。file driver、`TASKS_FILE` 和 `tasks.json` 回退均已移除；CSV/JSON 只用于导入导出传输或一次性旧数据迁移。

## 1. 连接与最低配置

应用、迁移器和 Node 维护工具从 `vue/.env` 或进程环境读取数据库配置。`DATABASE_URL` 非空时优先；否则会根据完整的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD` 自动生成连接串：

```dotenv
DATABASE_URL=
PGHOST=db-host
PGPORT=5432
PGDATABASE=pytaskgantt
PGUSER=app_user
PGPASSWORD=secret
PGSSLMODE=disable
PGSSLROOTCERT=
PGSSLCERT=
PGSSLKEY=
PGAPPNAME=pytaskgantt
PGPOOL_MAX=10
PGPOOL_IDLE_TIMEOUT_MS=30000
PGPOOL_CONNECTION_TIMEOUT_MS=5000
```

自动生成时会安全编码用户名、密码和数据库名；`PGHOST` 需为主机名或 IP，Unix socket 路径不适用此方式。`PGAPPNAME` 默认是 `pytaskgantt`，会写入 `pg_stat_activity.application_name`，生产环境建议设置为能区分部署环境和版本的稳定名称，例如 `pytaskgantt-prod-rpa-kanban`。

Node 连接支持三种明确的 TLS 模式：

- `disable`：仅用于可信本机开发；
- `require`：链路加密但不校验数据库身份；
- `verify-full`：校验证书链和主机名，生产上线清单要求使用此模式。

未设置 `PGSSLMODE` 时兼容默认为 `disable`。应用无法可靠判断数据库是否为同机 Unix socket、受控私网或公网托管实例，因此不会仅凭 `NODE_ENV=production` 强制改变既有连接方式；生产发布必须由上线清单显式设置并验证 `PGSSLMODE=verify-full`。`DATABASE_URL` 中已有的 `sslmode` 与 `PGSSLMODE` 必须一致。系统信任库不能验证私有 CA 时设置绝对路径 `PGSSLROOTCERT`；需要双向 TLS 时同时设置绝对路径 `PGSSLCERT` 和 `PGSSLKEY`。应用只在创建 Pool 时读取证书文件，不把内容写入配置、日志或连接参数。

`psql`、`backup.sh` 和 `rollback.sh` 不经过 Node 配置层，也不会自动读取 `.env`。两个运维脚本均接受 `DATABASE_URL` 或完整五项 `PG*`；使用连接串时，脚本会通过 `PGDATABASE` 环境传给 PostgreSQL 客户端，不会把含密码的连接串放入进程命令参数。生产运维命令也应显式导出标准 libpq 变量 `PGSSLMODE=verify-full`，私有 CA 场景同时导出 `PGSSLROOTCERT`。

- 数据库与 Node 维护工具要求 Node.js 20.19+；PostgreSQL 建议使用 13+，数据库编码使用 UTF-8。
- 运行 `verify.sql`、`backup.sh`、`rollback.sh` 的主机还必须安装兼容版本的 `psql`、`pg_dump`、`pg_restore`；生产 Node Alpine 镜像不内置这些客户端工具。
- 服务端通过 `pg.Pool` 连接数据库。
- 应用启动必须同时具备会话和影刀配置；`npm run migrate`、dev seed 和旧数据导入只校验各自需要的配置。
- `GET /api/health` 会查询 PostgreSQL，并返回 `storage: "postgres"` 和当前 schema version。

## 2. 版本化迁移

迁移文件位于 `storage/migrations/`：

| 版本 | 文件 | 主要内容 |
|:---|:---|:---|
| 001 | `001_add_users_and_task_ownership.sql` | `app_users`、任务所有权、标签、备注、版本、软删除和影刀绑定字段 |
| 002 | `002_add_executions_and_binding_history.sql` | 计划绑定历史和影刀执行记录 |
| 003 | `003_add_audit_and_sessions.sql` | 任务审计与 PostgreSQL 会话表 |
| 004 | `004_finalize_postgres_only_schema.sql` | 时间戳 trigger、约束、历史绑定重建和 PostgreSQL-only 最终结构 |
| 005 | `005_add_durable_run_requests.sql` | 立即执行持久化请求、稳定幂等 UUID、失败恢复与审计关联 |
| 006 | `006_add_binding_scoped_sync_generation.sql` | 绑定范围同步代次，阻止旧请求或换绑前请求覆盖新同步状态 |

推荐命令：

```bash
cd vue
npm run migrate
```

`npm run migrate:pg` 是同一 migration runner 的兼容别名，不再表示“把任务文件整表迁入 PostgreSQL”。

迁移器具有以下保证：

- 按版本顺序发现并执行 `001` 到最新版本。
- 使用 PostgreSQL advisory lock，避免多个部署进程同时迁移。
- 每个版本在独立事务中执行，失败的版本整体回滚。
- 在 `schema_migrations` 记录版本、文件名、SHA-256 checksum 和应用时间。
- 已执行版本的文件名或内容发生变化时拒绝继续，防止静默改写历史。
- 重复执行时只处理待执行版本。

### psql 快照入口

全新数据库也可以由 DBA 使用原子快照：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f storage/schema.sql
```

`storage/schema.sql` 使用 `\ir` 按同一顺序包含迁移文件，并写入完全相同的 checksum。不要手工复制其中部分 SQL，也不要同时并行运行 psql 快照和 Node migration runner。

## 3. 启动 schema 门禁

应用启动只执行只读校验，不会自动创建或升级表。以下任一情况都会拒绝启动：

- `schema_migrations` 不存在；
- 数据库缺少当前应用要求的迁移；
- 数据库版本比当前应用支持的版本更新；
- 已应用迁移的文件名或 checksum 与仓库不一致。

因此部署顺序必须是：进入维护窗口并停止所有旧写入方 → 记录任务行数/最大 ID 基线 → 完整备份 → 执行迁移与只读校验 → 复核基线差异 → 启动新应用。不要在旧版应用仍可写库时迁移，也不要依赖容器重启自动补表；若维护窗口内仍出现新任务或更新时间变化，应先查明写入来源。

## 4. 旧库原地升级与旧文件导入

### 4.1 旧四列表原地升级

如果数据库已存在旧版 `rpa_tasks(id, task, start_time, finish_time, bot)`，迁移会：

- 保留原有任务和 ID；
- 将主键升级为服务端分配的 BIGINT identity，并同步 identity 序列；
- 增加所有权、绑定、标签、备注、版本、同步状态、时间戳和软删除字段；
- 让旧任务的 `owner_user_id`、`created_by_user_id`、`schedule_uuid` 保持为空。

这类历史任务继续出现在全员任务中，但 `can_edit=false`，不会进入“我的任务”。迁移不会猜测所有者或影刀计划。

### 4.2 从旧 CSV/JSON 无覆盖导入

旧文件不是运行时数据源。如需导入，使用独立工具：

```bash
node storage/importLegacyTasks.cjs --file ../ShadowBot_tasks.csv
# 或
LEGACY_TASKS_FILE=../legacy-tasks.json node storage/importLegacyTasks.cjs
```

行为：

- 读取旧四列 CSV 或 JSON 数组；
- 有 ID 时尽量保留，主键已存在则跳过；无 ID 时由 PostgreSQL 分配；
- 不清空、不覆盖现有任务；
- 完成后修正 identity 序列；
- 新增行的所有者和计划绑定为空，作为历史只读任务展示。

页面上的 `/api/import` 与此工具不同：页面导入要求每行提供 `ScheduleUuid`，以 create mutation 为当前用户追加可编辑任务。

### 4.3 原子补齐历史任务所有者与绑定

历史任务必须同时补齐 `owner_user_id`、`schedule_uuid`、`schedule_bound_at` 和一条匹配的活动 `rpa_task_binding_history`，并记录审计。使用工具完成，不要手工只更新任务表：

```bash
npm run backfill:task -- \
  --task-id 42 \
  --owner-user-id 7 \
  --schedule-uuid schedule-uuid-1 \
  --bound-at 2026-07-22T12:00:00+08:00
```

工具在单一事务内校验有效用户、任务未删除、计划未被其他有效任务占用，并写入或修复当前绑定历史与 `import` 审计。`--actor-user-id` 默认等于所有者；省略 `--bound-at` 时以当前时间生效。完成后必须运行 `storage/operations/verify.sql`。

## 5. 开发用户 seed

开发登录用户来自 `app_users`，先确保 `.env` 中 `AUTH_MODE=dev`，再运行：

```bash
npm run seed:dev -- 用户甲 用户乙
# 或
DEV_USER_NAMES=用户甲,用户乙 npm run seed:dev
```

脚本先校验数据库已经迁移到最新版本，仅创建不存在的 `auth_provider='dev'` 同名用户。它不会删除、停用或覆盖已有用户。

## 6. 持久化表

| 表 | 用途 |
|:---|:---|
| `schema_migrations` | 迁移版本和 checksum |
| `app_users` | 内部用户、开发身份及未来飞书身份字段 |
| `rpa_tasks` | 排班任务当前状态、所有权、绑定、版本、同步状态和软删除 |
| `rpa_task_binding_history` | scheduleUuid 的绑定生效与解除时间区间 |
| `rpa_task_executions` | 最近执行记录、归一化状态、作业 UUID 和启动人 |
| `rpa_task_run_requests` | 立即执行 outbox、稳定幂等 UUID、重试状态及审计关联 |
| `rpa_task_audit_log` | create/update/delete/rebind/transfer/import/run_now 审计 |
| `app_sessions` | `express-session` 服务端会话 |

关键约束：

- `rpa_tasks.id` 和其他内部主键使用 BIGINT；API 以字符串返回 ID，避免 JavaScript 精度丢失。
- 活跃任务的 `schedule_uuid` 通过部分唯一索引保证一对一绑定。
- 新任务必须同时具备创建者、所有者、`schedule_uuid` 和 `schedule_bound_at`。
- 历史迁移任务允许所有权和绑定为空，但只能读取。
- `version` 从 1 开始，任务字段、所有权、绑定或删除发生 mutation 时递增。
- 删除使用 `deleted_at` 软删除，并关闭当前绑定区间。
- 执行记录按影刀 `task_uuid` 幂等写入；绑定历史决定一条执行归属哪个平台任务。
- `sync_generation` 只允许当前绑定最新一次同步请求更新 `last_synced_at/sync_error`。
- 立即执行请求在远端调用前提交稳定 UUID；远端调用不持有任务行锁或数据库事务。
- 完整作业日志不写入 PostgreSQL，只在请求时从影刀获取并短期缓存。

## 7. 会话与权限

会话存储使用 `app_sessions`，应用 Cookie 默认名为 `pytaskgantt.sid`：

```dotenv
AUTH_MODE=dev
SESSION_SECRET=replace-with-a-random-secret
SESSION_MAX_AGE_SECONDS=28800
SESSION_COOKIE_NAME=pytaskgantt.sid
```

- Cookie 为 HttpOnly、SameSite=Lax；生产环境启用 Secure 和 `trust proxy`。
- 会话滚动续期，关联的用户必须仍然存在且 `is_active=true`。
- 所有 `/api` 业务路由都要求会话；匿名仅能访问健康检查和登录相关接口。
- 所有权、版本、唯一绑定和写请求来源均由后端校验，前端的禁用状态不是安全边界。

`AUTH_MODE=dev` 实现了手动切换开发用户。`AUTH_MODE=feishu` 目前只是预留配置：它关闭 dev 用户接口，但**没有飞书 OAuth 跳转、回调或建会话逻辑**。生产环境默认拒绝 dev 模式；`ALLOW_DEV_AUTH_IN_PRODUCTION=true` 仅可用于隔离、受控的临时环境。

前端通过三条路由使用上述会话：`/login` 创建或恢复会话，`/schedule` 读取全员任务，`/my-tasks` 只读取当前用户拥有的任务。业务页和对应 API 都不能绕过服务端会话与所有权检查。

## 8. 任务写入与事务

常规保存使用 `POST /api/tasks/batch`，不做整表对比或整表覆盖：

- create：验证计划在影刀存在且未绑定，服务端生成 ID，当前用户同时成为创建者和所有者；
- update：锁行并校验 `owner_user_id` 和 `version`，只更新提交的字段；
- delete：锁行并校验所有权/版本，软删除并释放绑定；
- 整个 batch 使用一个事务，任何一项失败都回滚；
- 每项写入同步记录审计。

换绑和转交使用独立事务，同样校验所有权与乐观锁版本。立即执行会校验所有权、有效绑定和活动执行状态，并记录幂等 UUID 与审计。

页面导入复用 create mutation，只追加当前用户任务；它不会 `DELETE FROM rpa_tasks`，也不会替换其他用户的数据。

## 9. 影刀同步与数据库边界

服务启动后会：

1. 从 `rpa_task_executions` 恢复等待中/运行中实例的轮询；
2. 立即执行一次全局增量同步；
3. 按 `YINGDAO_SYNC_INTERVAL_SECONDS` 周期继续全局同步；
4. 每日清理超过 `EXECUTION_RETENTION_DAYS` 的执行记录。

全局同步默认回看最近 2 天；用户触发“同步我的任务”或单任务同步时按执行保留期回看。执行记录先按 `rpa_task_binding_history` 的时间区间归属，避免换绑后把旧执行错误挂到新任务。同步失败只更新 `sync_error`，不删除或覆盖上次有效状态。

无法识别的上游状态会保留原始值并按活动状态保守处理：任务显示“未知状态”，继续轮询并阻止再次立即执行，直到影刀返回可识别终态，以避免新增状态枚举导致重复启动。

计划列表/详情和作业日志使用进程内短期缓存；数据库仍是页面状态和执行历史的唯一持久化来源。单实例部署下后台协调器、轮询锁和缓存位于进程内；唯一绑定、事务、会话和并发版本仍由 PostgreSQL 保证。

## 10. 数据库权限

迁移必须使用具备 DDL 权限的独立部署角色；应用 `DATABASE_URL` 使用另一个无对象所有权、无角色继承的登录角色。运行时所需权限按表收紧为：

- `USAGE` on schema `public`；
- `schema_migrations` 只读；
- 用户、任务、绑定历史和立即执行 outbox 为 `SELECT/INSERT/UPDATE`；
- 执行记录额外需要 `DELETE` 以执行保留期清理；
- 审计表只允许 `SELECT/INSERT`；
- `app_sessions` 允许 `SELECT/INSERT/UPDATE/DELETE`；
- 四个 identity sequence 只允许 `USAGE`。

仓库提供可重复执行的授权与只读验证脚本。先以迁移 owner 完成迁移，再执行：

```bash
PGDATABASE="$MIGRATION_DATABASE_URL" psql -v ON_ERROR_STOP=1 \
  -v runtime_role=pytaskgantt_runtime \
  -f storage/operations/grant-runtime-role.sql

# 后续可单独执行只读复核：
PGDATABASE="$MIGRATION_DATABASE_URL" psql -v ON_ERROR_STOP=1 \
  -v runtime_role=pytaskgantt_runtime \
  -f storage/operations/verify-runtime-role.sql
```

授权脚本会拒绝把数据库、`public` schema 或应用对象 owner 当作运行时角色，清除危险 role attributes，撤销应用对象的 `PUBLIC` 权限和 `public` schema 的公共 `CREATE`，然后只授予上述权限。验证脚本检查最终**有效权限**，因此额外的角色 membership 或 `PUBLIC`/组角色授权也会导致失败；这类继承关系必须由 DBA 先移除。新增迁移若增加表或 sequence，应同步更新脚本并在迁移后重新执行。不要使用 `GRANT ... ON ALL TABLES` 或 `ALTER DEFAULT PRIVILEGES` 给运行时角色自动扩权。

应用启动本身不会执行 DDL；`npm run migrate` 和 `storage/schema.sql` 需要建表、改表、索引、函数及 trigger 权限，不能改用受限运行时角色。

## 11. Docker 上线流程

容器镜像包含 migration runner 和 SQL 文件，但不会自动运行迁移。推荐顺序：

```bash
docker compose build
docker compose run --rm pytaskgantt npm run migrate
docker compose up -d
```

回滚应用版本前也要确认旧版本能识别当前数据库 schema；启动门禁会拒绝“数据库版本过新”的组合。生产环境至少确认：

- `DATABASE_URL` 或完整五项 `PG*` 指向已备份且可迁移的数据库；
- PostgreSQL 使用 `verify-full`，且运行时角色通过最小权限验证；
- `PGAPPNAME` 能从 `pg_stat_activity` 区分当前部署与遗留写入方；
- `CORS_ORIGIN` 是只含精确 origin（无路径、查询、通配符）的 HTTPS allowlist；
- `SESSION_SECRET` 至少 32 个字符；
- 影刀凭证通过 secret 管理注入；
- 认证模式与真实登录能力匹配，不能把预留的 `AUTH_MODE=feishu` 当成已完成 OAuth。

## 12. 验证与排障

```bash
npm run migrate
npm run seed:dev -- 测试用户
npm test
npm run test:node
npm run build
```

### 真实 PostgreSQL 集成测试

`npm test` 保持为不依赖外部服务的常规测试。真实事务、约束、会话和权限边界由独立入口 `npm run test:postgres` 验证；该入口要求显式设置 `TEST_DATABASE_URL`，变量缺失时会以非零状态退出，不能静默跳过。

集成测试会在每个用例前对 `app_sessions`、任务、绑定、执行、立即执行请求、审计和用户表执行 `TRUNCATE ... RESTART IDENTITY CASCADE`。必须新建专用、可丢弃的隔离数据库，不得指向开发库、共享测试库或生产库。该数据库需要由当前分支迁移到最新 schema，测试角色还需具备相关表的读写、`TRUNCATE` 和 sequence 重置权限：

```bash
createdb --owner=test_user pytaskgantt_integration  # 示例假设专用角色 test_user 已存在
export TEST_DATABASE_URL='postgresql://test_user:test_password@localhost:5432/pytaskgantt_integration'
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run test:postgres
```

若使用 Docker 或 CI，请为每次作业创建独立数据库或独立 PostgreSQL 实例，先迁移、再测试，完成后销毁。不要把应用运行时的 `DATABASE_URL` 自动复用为 `TEST_DATABASE_URL`，这一显式隔离是防止误清数据的安全门禁。

上线 shell 操作需先显式导出连接配置，并使用已安装的 PostgreSQL 客户端工具。以下连接串写法不会把连接串放进 `psql`、`pg_dump` 或 `pg_restore` 的命令参数：

```bash
export DATABASE_URL='postgresql://migration_user:secret@db-host:5432/pytaskgantt'
export PGSSLMODE=verify-full
export PGAPPNAME=pytaskgantt-production-ops
PGDATABASE="$DATABASE_URL" psql -v ON_ERROR_STOP=1 -f storage/operations/verify.sql
storage/operations/backup.sh /absolute/path/pytaskgantt-before-upgrade.dump
# 只有停服且明确确认恢复时：
CONFIRM_RESTORE=RESTORE_BACKUP storage/operations/rollback.sh /absolute/path/pytaskgantt-before-upgrade.dump
```

也可以不设置 `DATABASE_URL`，改为完整导出 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD` 后直接运行相同命令。备份脚本以 `umask 077` 创建文件；回滚脚本要求绝对备份路径和 `CONFIRM_RESTORE=RESTORE_BACKUP`，并通过字面量空参数 `pg_restore --dbname=` 让 libpq 从环境读取连接配置，在单一事务中直接恢复。该参数不包含连接信息，因此真实连接串和密码不会进入进程参数。

上线前用迁移 owner 执行以下只读查询，确认所有旧写入方已经停止；`application_name` 为空或名称不在发布清单内的连接必须先查明来源：

```sql
SELECT pid, usename, application_name, client_addr, state, backend_start
  FROM pg_stat_activity
 WHERE datname = current_database()
   AND backend_type = 'client backend'
 ORDER BY backend_start;
```

常见错误：

- `SCHEMA_NOT_INITIALIZED`：先运行 `npm run migrate`。
- `SCHEMA_OUTDATED`：应用比数据库新，执行待迁移版本。
- `SCHEMA_TOO_NEW`：应用比数据库旧，升级应用或使用兼容版本，不要篡改迁移记录。
- `MIGRATION_CHECKSUM_MISMATCH`：已执行迁移文件被修改；恢复原文件并新增下一版本迁移。
- `PGSSLMODE`：生产上线应显式使用 `verify-full`；检查数据库证书、主机名和私有 CA 路径。
- TLS certificate file：证书路径必须为绝对路径且对 Node 运行用户可读。
- `CORS_ORIGIN`：生产只接受精确 HTTPS origin；不能混入 `*`、HTTP、路径或查询参数。
- dev 用户列表为空：确认 `AUTH_MODE=dev` 并运行 `npm run seed:dev`。
- 服务能启动但无法登录：若为 `AUTH_MODE=feishu`，当前仓库没有 OAuth 实现；切回受控 dev 环境或完成真实身份接入。
