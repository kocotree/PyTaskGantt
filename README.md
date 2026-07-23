# PyTaskGantt

面向团队的 RPA 任务排班与执行看板。系统以 Vue 3 + Express 5 提供全员甘特图和个人任务页，以 PostgreSQL 作为唯一运行时数据源，并通过影刀开放 API 关联计划、同步执行状态、查看历史与日志、立即执行任务。

![Vue](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive%20UI-2-63e2b7)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-required-4169e1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

> [!IMPORTANT]
> 当前版本不再支持 file driver，也不会在后端不可用时回退到 `tasks.json`。CSV/JSON 只用于导入导出，PostgreSQL 是任务、用户、会话、绑定、审计和执行记录的唯一持久化来源。

## 功能概览

- **全员任务**：已登录用户可以查看全部未删除任务；只有任务所有者可以编辑、拖拽或删除自己的任务。
- **我的任务**：个人页仅返回当前用户拥有且已绑定影刀计划的任务，支持搜索、标签和状态筛选。
- **安全保存**：页面保留“修改后点击保存”的交互，但只提交实际发生的 `create` / `update` / `delete` mutation，不再发送或覆盖整张任务表。
- **并发保护**：更新和删除携带任务 `version`，后端同时校验所有权和版本；冲突会拒绝写入，不会静默覆盖他人修改。
- **影刀绑定**：新任务必须选择唯一的 `scheduleUuid`；支持所有者换绑、转交、手动同步和立即执行。
- **运行可观测性**：集中同步影刀执行记录并归一化状态，支持查看执行历史、作业和按需日志。
- **软删除与审计**：删除只影响本平台并立即释放计划绑定；创建、修改、删除、换绑、转交、导入和立即执行均记录审计。
- **CSV/JSON 传输**：导入会为当前用户新增任务，导出当前登录用户可见的任务；导入不是整表替换。
- **服务端会话**：会话保存在 PostgreSQL `app_sessions`，所有业务 API 都由后端执行登录和权限校验。

时间字段仍使用 `HH:MM:SS`。当 `Finish < Start` 时表示任务跨越午夜，例如 `23:30:00 → 01:15:00` 记为次日结束。

## 技术栈

| 层 | 技术 |
|:---|:---|
| 前端 | Vue 3 · Vue Router · Naive UI · vis-timeline |
| 后端 | Express 5 · express-session · Zod |
| 数据库 | PostgreSQL · `pg` · connect-pg-simple |
| 外部集成 | 影刀开放 API |
| 构建与测试 | Vite 8 · Vitest · node:test · Supertest |
| 部署 | Node.js 20 · Docker 多阶段构建 · Traefik（可选）|

## 快速开始

### 前置要求

- **Node.js 20.19+** 和 npm（Vite 8 的最低要求）
- **PostgreSQL 13+**
- PostgreSQL 客户端工具（上线验证、备份和恢复需要 `psql`、`pg_dump`、`pg_restore`）
- 可用的影刀开放 API Access Key ID / Secret
- Docker（仅容器部署需要）

### 1. 安装并配置

```bash
cd vue
cp .env.example .env
npm install
```

至少修改 `.env` 中的以下值：

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=pytaskgantt
PGUSER=pytaskgantt
PGPASSWORD=change-me
AUTH_MODE=dev
SESSION_SECRET=replace-with-a-random-secret
YINGDAO_ACCESS_KEY_ID=replace-me
YINGDAO_ACCESS_KEY_SECRET=replace-me
```

也可以只配置完整的 `DATABASE_URL`。显式连接串非空时优先；否则服务、迁移器和 Node 维护工具会根据完整的五项 `PG*` 自动生成，并对用户名、密码和数据库名进行 URL 编码。

### 2. 执行数据库迁移

```bash
npm run migrate
```

`npm run migrate:pg` 是同一命令的兼容别名。迁移器按顺序执行 `storage/migrations/001` 到 `006`，记录 SHA-256 checksum；应用启动只校验版本，不会自动执行 DDL。数据库缺少迁移、版本落后、版本过新或已执行迁移文件被改写时，服务都会拒绝启动。

### 3. 创建开发用户

```bash
npm run seed:dev -- 用户甲 用户乙
# 或
DEV_USER_NAMES=用户甲,用户乙 npm run seed:dev
```

该命令只在 `AUTH_MODE=dev` 时可用，重复执行会保留已有同名开发用户。

### 4. 启动开发环境

```bash
npm start
```

访问：

- 前端：<http://localhost:5174>
- 后端健康检查：<http://localhost:3002/api/health>

也可以分别启动或构建：

```bash
npm run server       # 仅 Express，默认 :3002
npm run dev          # 仅 Vite，默认 :5174
npm run build        # 生产构建，产物在 dist/
```

## 身份、会话与权限

当前已实现的登录方式是开发用户切换：

- `AUTH_MODE=dev` 时，`/login` 从 `app_users` 读取有效的 dev 用户并创建服务端会话。
- 会话 Cookie 为 HttpOnly、SameSite=Lax，生产环境启用 Secure，并采用滚动过期。
- 除 `GET /api/health`、登录相关接口和前端静态资源外，所有业务 API 都要求有效会话。
- 写请求还会检查 `CORS_ORIGIN`；生产环境禁止使用 `*`。
- 权限使用不可变的内部 `user_id` 判断，不使用显示名称作为身份主键。

| 操作 | 权限 |
|:---|:---|
| 查看全员任务、执行记录、作业和日志 | 任意已登录用户 |
| 查看“我的任务” | 仅返回当前用户任务 |
| 新建、导入任务 | 任意已登录用户；新任务归当前用户 |
| 编辑、拖拽、删除、换绑、转交、立即执行、单任务同步 | 仅当前所有者 |
| 同步“我的任务” | 仅同步当前用户拥有的任务 |

> [!WARNING]
> 本期**没有实现飞书 OAuth**。`AUTH_MODE=feishu` 只是为后续接入预留：它会关闭开发用户列表与切换接口，但不会提供 OAuth 跳转、回调或自动建会话。当前 `AUTH_MODE=dev` 仅适用于本地、测试或其他受控环境；`NODE_ENV=production` 默认拒绝 dev 模式，只有显式设置 `ALLOW_DEV_AUTH_IN_PRODUCTION=true` 才能启动，该开关不得用于开放公网环境。

## 页面路由

| 路径 | 说明 |
|:---|:---|
| `/login` | 开发用户选择页；未登录访问业务页会跳转至此 |
| `/schedule` | 全员甘特图，展示全部未删除任务并按 `can_edit` 控制编辑能力 |
| `/my-tasks` | 当前用户的个人任务列表、筛选、同步、换绑、转交和立即执行入口 |

`/` 重定向到 `/schedule`。API 返回 401 时，前端统一清理会话和草稿状态并跳回 `/login`；跨页面离开和退出登录时会提示未保存修改。

## 任务保存模型

前端为两个业务页面分别维护任务草稿，并只记录发生变化的任务：

```json
{
  "mutations": [
    { "type": "create", "temp_id": "tmp:...", "task": "日报", "start": "09:00:00", "finish": "09:30:00", "bot": "机器人A", "schedule_uuid": "...", "tags": [], "note": "" },
    { "type": "update", "id": "42", "version": 3, "changes": { "start": "09:10:00" } },
    { "type": "delete", "id": "51", "version": 2 }
  ]
}
```

保存请求发送到 `POST /api/tasks/batch`，整个批次在一个数据库事务中处理：

1. 新建任务由 PostgreSQL 分配 BIGINT identity，后端返回临时 ID 到正式 ID 的映射。
2. 更新和删除先锁定任务，再校验所有者和 `version`。
3. 更新只写 mutation 中列出的字段并递增版本。
4. 删除采用软删除，关闭绑定历史并立即释放当前 `scheduleUuid`。
5. 任一 mutation 失败时整批回滚。

轮询刷新会更新运行状态等服务端字段，同时保留尚未保存的本地草稿。

## CSV / JSON 导入导出

CSV 示例：

```csv
Task,Start,Finish,Bot,ScheduleUuid,Tags,Note
数据同步,09:00:00,09:25:00,机器人A,schedule-uuid-1,日报;财务,工作日运行
日志分析,23:30:00,01:15:00,机器人B,schedule-uuid-2,夜间,跨天任务
```

- 导入的 `Task`、`Start`、`Finish`、`Bot`、`ScheduleUuid` 都是必填项。
- CSV 标签用分号分隔；JSON 中 `tags` 可使用数组。
- 导入复用 create mutation：逐条校验计划存在且未被绑定，任务归当前用户，已有任务不会被删除或覆盖。
- 导出包含任务元数据和所有者信息，不包含执行历史和完整日志。
- 旧四列 CSV/JSON 不能通过页面导入为可编辑新任务；如需迁移历史数据，请使用“旧数据导入”命令。

旧数据无覆盖导入：

```bash
node storage/importLegacyTasks.cjs --file ../ShadowBot_tasks.csv
```

该工具保留可用的旧 ID，主键冲突时跳过，不覆盖现有行；导入结果的 `owner_user_id` 和 `schedule_uuid` 为空，因此会在全员任务中作为历史只读任务显示，不进入“我的任务”。

确认计划 UUID 后，使用原子补齐工具同时写入所有者、当前绑定时间、绑定历史和审计；不要直接只改任务表中的两个列：

```bash
npm run backfill:task -- \
  --task-id 42 \
  --owner-user-id 7 \
  --schedule-uuid schedule-uuid-1 \
  --bound-at 2026-07-22T12:00:00+08:00
```

`--actor-user-id` 可选，默认等于所有者；省略 `--bound-at` 时以执行命令的当前时间作为绑定生效时间。

## 影刀配置与同步

核心配置：

| 变量 | 默认值 | 说明 |
|:---|:---|:---|
| `YINGDAO_ACCESS_KEY_ID` | 无 | 必填，不得提交真实值 |
| `YINGDAO_ACCESS_KEY_SECRET` | 无 | 必填，不得提交真实值 |
| `YINGDAO_BASE_URL` | `https://api.yingdao.com` | 开放 API 根地址 |
| `YINGDAO_REQUEST_TIMEOUT_MS` | `15000` | 单次请求超时 |
| `YINGDAO_SYNC_INTERVAL_SECONDS` | `60` | 后台全局增量同步周期 |
| `YINGDAO_SCHEDULE_CACHE_SECONDS` | `60` | 计划列表/详情新鲜缓存 |
| `YINGDAO_BIND_CACHE_MAX_AGE_SECONDS` | `300` | 远端失败时允许用于绑定校验的可信缓存上限 |
| `EXECUTION_RETENTION_DAYS` | `30` | PostgreSQL 执行记录保留期 |
| `JOB_LOG_CACHE_SECONDS` | `300` | 作业日志进程内缓存时间；完整日志不长期落库 |
| `UI_REFRESH_SECONDS` | `10` | 前端读取 PostgreSQL 最新状态的周期，最小 5 秒 |

服务启动后会恢复未结束执行的轮询，立即做一次全局增量同步，此后按配置周期继续同步。用户还可以在个人页同步自己的全部任务，或同步单个任务。同步记录依据计划绑定时间区间归属到任务，换绑前的历史仍保留在原任务下；同步失败只记录 `sync_error`，不会覆盖上次有效执行状态。

无法识别的影刀状态会保留原始值并按活动状态保守处理：页面显示“未知状态”，后台继续轮询，并暂时阻止同一任务再次立即执行，直到取得可识别的终态。这是实施计划“未知值保守处理”的具体行为，避免状态枚举变化造成重复启动。

立即执行先把稳定幂等 UUID 持久化到 outbox，再在数据库事务外调用影刀；远端成功而本地提交失败或服务重启时会复用同一 UUID 恢复，避免重复启动。影刀 Token、限流、有限重试和凭证脱敏由服务端统一处理。影刀无时区时间固定按 `Asia/Shanghai` 解析和格式化。

## 运行时配置

`vue/.env`（不入库，从 `.env.example` 复制）是本地运行配置源：

| 分组 | 变量 |
|:---|:---|
| 服务 | `NODE_ENV`、`PORT`、`VITE_DEV_PORT`、`VITE_DEV_HOST`、`CORS_ORIGIN` |
| PostgreSQL | `DATABASE_URL`，或 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`；可选 `PGSSLMODE`、证书路径、`PGAPPNAME` 及 pool 参数 |
| 身份与会话 | `AUTH_MODE`、`ALLOW_DEV_AUTH_IN_PRODUCTION`、`SESSION_SECRET`、`SESSION_MAX_AGE_SECONDS`、`SESSION_COOKIE_NAME` |
| 影刀 | `YINGDAO_ACCESS_KEY_ID`、`YINGDAO_ACCESS_KEY_SECRET`、`YINGDAO_BASE_URL`、请求/同步/缓存参数 |
| 执行与页面 | `EXECUTION_RETENTION_DAYS`、`JOB_LOG_CACHE_SECONDS`、`UI_REFRESH_SECONDS` |

完整数据库说明见 [vue/POSTGRESQL.md](vue/POSTGRESQL.md)。

## 测试与构建

在 `vue/` 目录运行：

```bash
npm test                              # 全部测试（Vitest + node:test）
npm run test:vitest                   # Vitest 会话、API 与前端测试
npm run test:node                     # node:test 数据库、影刀与同步测试
npm run test:backend                  # 后端、影刀与执行同步测试
npm run test:frontend                 # 前端 API 与草稿状态测试
npm run test:postgres                 # 真实 PostgreSQL 事务与权限测试（需 TEST_DATABASE_URL）
npm run build                         # 生产构建验证
```

真实 PostgreSQL 测试会反复清空应用表，只能连接已完成迁移的专用隔离数据库，不能使用开发、共享或生产数据库：

```bash
export TEST_DATABASE_URL='postgresql://test_user:test_password@localhost:5432/pytaskgantt_integration'
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run test:postgres
```

未设置 `TEST_DATABASE_URL` 时，`test:postgres` 会明确失败，不会把跳过集成测试当作成功。常规 `npm test` 不连接真实数据库；数据库集成门禁应单独执行。更完整的隔离库说明见 [vue/POSTGRESQL.md](vue/POSTGRESQL.md#真实-postgresql-集成测试)。

仓库当前没有 lint/format 脚本，不要假定 `npm run lint` 存在。

## Docker 部署

镜像使用 Node 20 Alpine，多阶段构建前端，并在生产层复制 `server/`、`lib/`、`storage/` 和迁移文件。容器不会自动迁移数据库，应用启动也只做只读 schema 校验，因此每次上线包含新迁移的版本前必须先执行迁移：

### 本地 Docker Compose 测试

本地测试使用 [docker-compose.test.yml](vue/docker-compose.test.yml)。它与生产部署保持相同的单应用服务、生产镜像和手动迁移流程，不内置 PostgreSQL，也不会覆盖任何数据库变量；应用容器的运行时环境全部从 `vue/.env` 读取。

先自行创建本地测试数据库，再确认 `.env` 中 `DATABASE_URL` 或完整五项 `PG*` 指向该数据库。若 PostgreSQL 运行在宿主机，容器内不能使用 `localhost`，应设置 `PGHOST=host.docker.internal`；使用 `DATABASE_URL` 时也要把其中的主机名改成 `host.docker.internal`。本地 HTTP/dev 登录建议保留 `NODE_ENV=development`、`AUTH_MODE=dev`，并让 `CORS_ORIGIN` 包含 `http://localhost:3002`。

```bash
cd vue

# 构建与生产部署相同的最终镜像。
docker compose -f docker-compose.test.yml build

# 使用同一个应用镜像创建/升级 001-006 表结构。
docker compose -f docker-compose.test.yml run --rm pytaskgantt npm run migrate

# 创建本地开发登录用户，然后启动应用。
docker compose -f docker-compose.test.yml run --rm pytaskgantt npm run seed:dev -- 苕尖
docker compose -f docker-compose.test.yml up -d pytaskgantt
docker compose -f docker-compose.test.yml ps

# 访问 http://localhost:3002/login
# 查看日志：docker compose -f docker-compose.test.yml logs -f pytaskgantt

# 只停止应用容器；外部数据库由你自行保留或清理。
docker compose -f docker-compose.test.yml down --remove-orphans
```

如需使用其他本地开发用户名，可在 seed 命令末尾传入名称，或在 `.env` 中设置 `DEV_USER_NAMES=用户甲,用户乙`。此 Compose 文件不会运行 `npm run test:postgres`；真实 PostgreSQL 集成测试会执行 `TRUNCATE ... RESTART IDENTITY CASCADE`，必须继续使用单独的可丢弃数据库，不能复用这里的界面联调库。

### 生产 Compose 模板

```bash
cd vue
cp docker-compose.yml.example docker-compose.yml

# 配置 DATABASE_URL 或完整 PG*，以及 CORS_ORIGIN、SESSION_SECRET、影刀凭证和认证模式后：
docker compose build
docker compose run --rm pytaskgantt npm run migrate
docker compose up -d
```

若迁移失败，不要启动新应用版本；修复数据库或配置后重新执行迁移。部署时还需注意：

- `CORS_ORIGIN` 使用实际 HTTPS 地址，不能是 `*`。
- `SESSION_SECRET` 在生产环境至少 32 个字符。
- 数据在外部 PostgreSQL 中持久化，应用容器不使用任务文件数据卷。
- `AUTH_MODE=feishu` 当前没有 OAuth 实现；公开生产环境需先完成真实身份接入。
- 仅在隔离、受控的临时环境中使用 `AUTH_MODE=dev`，并显式传入 `ALLOW_DEV_AUTH_IN_PRODUCTION=true`。
- Compose 模板默认通过已有 Traefik external 网络暴露服务；证书解析器、域名和网络名必须与实际环境一致。

常用命令：

```bash
docker compose ps
docker compose logs -f pytaskgantt
docker compose run --rm pytaskgantt npm run migrate
docker compose up -d --build
```

## 项目结构

```text
PyTaskGantt/
├── RPA_KANBAN_IMPLEMENTATION_PLAN.md
├── README.md
└── vue/
    ├── server.cjs                  # 启动、关闭和静态资源托管
    ├── server/                     # 配置、路由、中间件、仓储、影刀与同步服务
    ├── storage/
    │   ├── migrations/             # 001-006 有序数据库迁移
    │   ├── migrate.cjs             # migration runner
    │   ├── seedDevUsers.cjs        # 开发用户 seed
    │   ├── importLegacyTasks.cjs   # 旧 CSV/JSON 无覆盖导入
    │   ├── backfillLegacyTask.cjs  # 历史任务所有者/绑定/审计原子补齐
    │   └── schema.sql              # psql 原子快照入口
    ├── src/
    │   ├── router.js               # /login、/schedule、/my-tasks
    │   ├── pages/                   # 登录、全员任务、个人任务页
    │   ├── stores/taskDraftStore.js # mutation 草稿与保存状态
    │   └── services/                # 会话、任务、影刀 API 客户端
    └── test/                        # 后端、数据库、同步和前端测试
```
