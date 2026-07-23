# AGENT.md

This file provides guidance to coding agents working in this repository.

## 当前系统

PyTaskGantt 是 Vue 3 + Express 5 + PostgreSQL 的多用户 RPA 排班与执行看板，已集成影刀开放 API。运行时只有 PostgreSQL：不要恢复 file driver、`TASKS_FILE`、`src/data/tasks.json` 回退或整表覆盖保存。CSV/JSON 只用于导入导出和显式旧数据迁移。

任务保留 `task/start/finish/bot` 排班字段，并扩展所有者、创建者、唯一 `scheduleUuid` 绑定、标签、备注、乐观锁版本、软删除、同步状态、绑定历史、执行记录和审计。`Finish < Start` 表示跨天。

## 前置要求与常用命令

必须使用 **Node.js 20.19+**。命令均在 `vue/` 目录执行：

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed:dev -- 用户甲 用户乙
npm start

npm run server
npm run dev
npm run build

npm test
npm run test:vitest
npm run test:node
npm run test:backend
npm run test:frontend
```

`npm run migrate:pg` 是 `npm run migrate` 的兼容别名。仓库没有 lint/format 脚本，不要假定 `npm run lint` 存在。为验证启动的 Vite/Express 服务在测试结束后必须主动停止，释放默认 `:5174` / `:3002`。

## 配置事实

`vue/.env` 不入库。应用启动至少需要：

- `DATABASE_URL`，或完整的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`（显式 URL 优先）
- `SESSION_SECRET`
- `YINGDAO_ACCESS_KEY_ID`
- `YINGDAO_ACCESS_KEY_SECRET`

主要配置分组：

- 服务：`NODE_ENV`、`PORT`、`VITE_DEV_PORT`、`VITE_DEV_HOST`、`CORS_ORIGIN`
- PostgreSQL：拆分连接参数及 `PGPOOL_MAX`、`PGPOOL_IDLE_TIMEOUT_MS`、`PGPOOL_CONNECTION_TIMEOUT_MS`
- 身份：`AUTH_MODE`、`ALLOW_DEV_AUTH_IN_PRODUCTION`
- 会话：`SESSION_MAX_AGE_SECONDS`、`SESSION_COOKIE_NAME`
- 影刀：Base URL、超时、同步周期、计划缓存和可信绑定缓存
- 执行：`EXECUTION_RETENTION_DAYS`、`JOB_LOG_CACHE_SECONDS`、`UI_REFRESH_SECONDS`

生产环境拒绝 `CORS_ORIGIN=*`，也默认拒绝 `AUTH_MODE=dev`。`ALLOW_DEV_AUTH_IN_PRODUCTION=true` 只允许用于隔离、受控的临时环境。

> `AUTH_MODE=feishu` 当前只是预留值，不代表飞书 OAuth 已实现。它只会隐藏 dev 用户列表/切换接口；仓库没有 OAuth 跳转、回调和自动建会话逻辑。不要在文档、代码注释或交付说明中声称飞书登录可用。

## 数据库与迁移

- `storage/migrations/001-006` 是权威迁移历史。
- `storage/migrate.cjs` 使用 advisory lock、逐版本事务和 SHA-256 checksum。
- `storage/schema.sql` 是面向 psql 的原子快照入口。
- 服务启动只读校验 `schema_migrations`；缺失、落后、过新或 checksum 不一致均拒绝启动，绝不自动 DDL。
- Docker 上线前必须先执行 `npm run migrate`，再启动新容器。
- 不得修改已发布迁移；新增结构变化应追加下一个迁移并同步更新 snapshot/checksum 及测试。

旧四列表会原地升级并保留 ID；没有所有者/计划的历史任务只读。旧 CSV/JSON 使用：

```bash
node storage/importLegacyTasks.cjs --file <path>
```

该工具无覆盖插入，主键冲突跳过。页面 `/api/import` 是另一条路径：它要求 `ScheduleUuid`，为当前用户追加任务，不能替换整表。

开发用户通过以下方式 seed，且只允许 `AUTH_MODE=dev`：

```bash
npm run seed:dev -- 张三 李四
DEV_USER_NAMES=张三,李四 npm run seed:dev
```

## 后端结构与权限边界

- `server.cjs`：启动、优雅关闭、静态目录接入。
- `server/app.cjs`：Express、CORS、session、路由和错误处理中间件装配。
- `server/config.cjs`：环境变量验证；不要在其他模块重复解析安全配置。
- `server/db/`：Pool、迁移门禁和 users/tasks/executions/audit/run-request repositories。
- `server/routes/`：auth、tasks/import/export、yingdao 路由。
- `server/services/`：任务 mutation/action、影刀 client、同步、状态归一化和保留期清理。

匿名只允许健康检查、登录相关 API 和静态资源。其余 `/api` 必须经过 PostgreSQL session 校验；写请求还要经过 origin allowlist。Cookie 为 HttpOnly、SameSite=Lax，生产启用 Secure。

后端权限规则是安全边界：

- 任意已登录用户可查看全员任务、执行历史、作业和日志。
- `/api/my/tasks` 只返回当前用户拥有且已绑定的任务。
- 新建/导入任务归当前用户。
- 编辑、删除、拖拽落库、换绑、转交、立即执行和单任务同步仅限当前所有者。
- 历史未归属任务仍可查看，但 `can_edit=false`。
- 不依赖前端隐藏按钮或显示名称做授权。

## Mutation 保存约束

前端保存到 `POST /api/tasks/batch`，只发送实际变更：

- `create` 带临时 ID 和必填 `schedule_uuid`；正式 BIGINT ID 由服务端生成。
- `update` 带 `id`、`version` 和变化字段，不允许在普通 update 中改所有者或绑定。
- `delete` 带 `id` 和 `version`，后端软删除并释放绑定。
- batch 在单事务执行；每项锁行、校验所有者/版本并写审计；任一失败整批回滚。
- 换绑和转交走专用端点与事务。

禁止重新引入 `POST /api/tasks` 全量数组、根据客户端缺失行推断跨用户删除、`DELETE FROM rpa_tasks` 导入、前端自增正式 ID 或服务失败时本地数据兜底。

## 影刀集成约束

- 新任务必须绑定一个在影刀存在且当前未被活跃任务占用的 `scheduleUuid`。
- 活跃绑定由数据库部分唯一索引保证；换绑用 `rpa_task_binding_history` 保存时间区间。
- 后台启动时恢复活动执行轮询、做一次全局增量同步，随后按默认 60 秒周期同步。
- 手动同步个人任务/单任务按执行保留窗口查询历史。
- 执行按绑定区间归属；换绑前历史不能移动到新任务。
- 同步失败只写 `sync_error`，不能抹掉上次有效状态。
- 立即执行使用幂等 UUID，阻止同任务并发活动实例，并异步轮询至终态。
- 完整日志不落库，只按需查询并短期缓存；任何日志/错误不得泄露 Access Key 或 Token。

改影刀请求时保留 Token single-flight、401 单次刷新、限流、有限退避重试、超时、缓存可信年龄和敏感信息脱敏。

## 前端结构

三条业务路由：

- `/login`：当前仅开发用户选择。
- `/schedule`：全员甘特图。
- `/my-tasks`：个人任务、筛选、同步和执行操作。

关键文件：

- `src/router.js`：会话路由守卫、401 跳转和跨页未保存确认。
- `src/pages/SchedulePage.vue` / `MyTasksPage.vue`：页面编排。
- `src/stores/taskDraftStore.js`：两页各自的草稿、mutation 列表、版本和保存；这是未保存状态的真相源。
- `src/services/apiClient.js`：统一 `credentials: include`、错误解析和 401 处理。
- `src/services/authService.js` / `taskService.js` / `yingdaoService.js`：API 门面。
- `src/components/GanttChart.vue`：vis-timeline 拖拽；只允许 `can_edit` 任务更新。

轮询刷新必须保留本地 mutation 字段，同时合并服务端运行状态。离开路由、退出和刷新时继续保护未保存草稿。

所有时间先规范为 `HH:MM:SS`。vis-timeline 使用虚拟日期表示时间条；`Finish < Start` 时结束日期推到次日。改时间逻辑必须覆盖跨天测试。

## 测试与提交注意事项

修改后按风险运行对应测试，通常至少：

```bash
npm test
npm run build
```

数据库迁移、会话权限、mutation、影刀同步或前端草稿相关改动必须运行对应 backend/frontend/node:test 套件。`npm test` 会顺序运行 `test:vitest` 与 `test:node`。测试不得依赖真实影刀凭证，也不得输出 secret。

不要提交 `.env`、`dist/` 或 `node_modules/`。未经用户明确要求，不要执行 `git commit`、推送或新建/切换分支。保留用户已有的工作树修改，只改任务范围内文件。
