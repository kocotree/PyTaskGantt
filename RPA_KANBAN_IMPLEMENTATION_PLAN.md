# RPA 个人任务看板集成实施方案

> 文档状态：已确认，可进入开发
> 编写日期：2026-07-22
> 目标仓库：PyTaskGantt
> 参考项目：/Users/shaojian/project/rpa_kanban
> 影刀文档：[开放 API 使用指南](https://www.yingdao.com/yddoc/rpa/zh-CN/971279704374095872)

## 1. 背景

PyTaskGantt 当前是一个 Vue 3 + Express + PostgreSQL 的 RPA 排班沙盘，核心数据为任务名称、开始时间、结束时间和 Bot。用户可在甘特图中拖拽任务时间，并通过“保存”按钮将整张任务表写回后端。

rpa_kanban 是一个单人本地运行的影刀个人任务看板，使用 Python、Excel 和原生前端实现，具备计划绑定、运行状态、执行历史、日志、同步和立即执行等能力。

本次改造不是把 Python 服务和 Excel 直接嵌入 PyTaskGantt，而是将 rpa_kanban 的业务能力移植到现有 Node.js/Express/Vue 架构中，并将 PostgreSQL 作为唯一数据源。

## 2. 目标

改造完成后，系统应具备以下能力：

1. 通过同一个共享网址提供服务。
2. 主甘特图展示所有人的任务，所有用户均可查看。
3. 普通用户只能修改、拖拽、删除、换绑、转交和执行自己的任务。
4. 新增个人任务页面，只返回当前用户拥有的任务。
5. 每条新任务必须绑定一个唯一的影刀 scheduleUuid。
6. 从影刀集中同步真实运行状态、执行历史和日志。
7. 支持用户主动同步自己的全部任务和立即执行单个任务。
8. 开发阶段通过手动切换用户模拟登录，后续无缝替换为飞书 OAuth。
9. 保留现有“修改后点击保存”的交互方式，但不再整表覆盖数据库。
10. 支持 100+ 任务、5～10 名用户、高频计划和最长 2 小时以上的执行场景。

## 3. 非目标

本期明确不包含以下内容：

- 不运行 rpa_kanban 的 Python 服务。
- 不读写 rpa_kanban 的 Excel 文件。
- 不再支持 file、CSV 或 JSON 作为运行时数据源；CSV/JSON 仅作为导入导出传输格式。
- 不在本期接入飞书 OAuth。
- 不在本期发送飞书消息通知。
- 不通过本系统创建、修改或删除影刀计划。
- 不校验当前用户是否真的是影刀计划创建者。
- 不建设管理员角色、申诉流程或计划转移审批。
- 立即执行不接受自定义运行参数。
- 不长期保存完整影刀日志，日志按需查询并短期缓存。

## 4. 已确认的产品规则

### 4.1 身份与准入

- 所有业务 API 必须存在有效登录会话。
- 只有静态登录页面、前端静态资源和 GET /api/health 可以匿名访问。
- 开发阶段由用户在登录页手动切换当前用户。
- 开发用户来自 app_users 表。
- 开发切换接口只在 AUTH_MODE=dev 时启用。
- 生产环境必须关闭开发切换接口。
- 后续接入飞书时，用户首次登录自动写入 app_users。
- 内部权限判断统一使用不可变的内部 user_id，不使用姓名作为主键。

### 4.2 可见性与权限

| 操作 | 权限规则 |
|---|---|
| 查看主甘特图任务 | 任意已登录用户 |
| 查看个人任务页 | 仅返回当前用户任务 |
| 查看执行记录和日志 | 任意已登录用户 |
| 导出任务 | 任意已登录用户，可导出全部可见任务 |
| 新建任务 | 任意已登录用户，新任务归当前用户 |
| 修改任务字段 | 仅当前所有者 |
| 拖拽任务条 | 仅当前所有者 |
| 删除任务 | 仅当前所有者 |
| 换绑 scheduleUuid | 仅当前所有者 |
| 立即执行 | 仅当前所有者 |
| 转交所有权 | 仅当前所有者 |
| 导入任务 | 任意已登录用户，但只能为自己新增 |

所有权限必须由后端校验。前端隐藏按钮、禁用拖拽或显示锁图标只用于改善体验，不能作为安全边界。

### 4.3 任务与计划

- 原有任务字段继续作为排班沙盘数据，不与影刀自动同步。
- 任务名称、开始时间、结束时间、Bot、标签和备注均由用户维护。
- scheduleUuid 仅用于关联真实的影刀计划和执行记录。
- 当前有效绑定满足一条任务对应一个 scheduleUuid，且一个 scheduleUuid 只能被一条有效任务占用。
- 新任务创建时必须当场选择 scheduleUuid。
- 历史任务可暂时没有 owner_user_id 和 scheduleUuid。
- 未绑定历史任务继续显示在主页面，但只读且不进入个人页。
- 用户可换绑 scheduleUuid。
- 换绑前的执行历史继续保留在原任务下。
- 新绑定只接收 schedule_bound_at 之后产生的执行记录。
- 被换下或删除释放的 scheduleUuid 可以再次绑定给其他任务。
- 不验证绑定者是不是影刀计划真实创建者。
- 误绑由任务所有者自行删除或换绑处理。

### 4.4 删除与转交

- 删除只影响本平台，不调用影刀删除、停止或修改接口。
- 删除采用软删除。
- 删除后任务从普通页面隐藏，并立即释放当前 scheduleUuid。
- 已有执行历史继续保留到 30 天清理期限。
- 允许当前所有者把任务转交给另一名已存在用户。
- 转交立即生效，不要求接收人审批。
- scheduleUuid、标签、沙盘字段和全部执行历史随任务保留。
- created_by_user_id 永久记录创建者。
- owner_user_id 表示当前所有者。
- 转交必须记录审计信息。

### 4.5 标签

- 原“周期”概念改为自由文本标签。
- 标签不包含日期、周期窗口、双周锚点或调度语义。
- 一条任务可以有多个标签。
- 用户可直接输入任意标签文本。
- 写入前执行去首尾空格、去空值和去重。
- 个人页采用平铺列表和多选标签筛选，不按标签重复分组展示任务。

## 5. 当前实现与目标之间的差距

### 5.1 后端

当前 vue/server.cjs 存在以下问题：

- GET /api/tasks 返回所有任务，但没有用户身份和权限信息。
- POST /api/tasks 接收整张任务表，无法阻止用户修改或删除他人任务。
- POST /api/import 会整体替换数据库。
- 所有 API 均可匿名访问。
- 没有影刀客户端、同步任务、执行历史和状态聚合。
- server.cjs 同时承担启动、路由、数据校验和错误处理，继续堆叠会难以维护。

### 5.2 存储

当前 vue/storage/pgStore.cjs 只支持单表 rpa_tasks，且保存逻辑会根据客户端整表内容推断新增、修改和删除。

当前 vue/storage/index.cjs 仍支持 file 和 postgres 两种驱动；新版本应移除运行时驱动切换，只保留 PostgreSQL。

当前 vue/storage/schema.sql 只有任务名称、起止时间和 Bot，无法支持用户、计划绑定、执行历史、软删除、审计和并发版本校验。

### 5.3 前端

当前 vue/src/services/dataService.js 存在以下问题：

- 服务器请求失败时会加载本地 tasks.json，违背 PostgreSQL 唯一事实源。
- 使用模块级 tasksData 保存整张表。
- 未保存状态只有一个布尔值，无法知道具体修改了哪些任务。
- 保存时发送整张任务表。
- 新建任务 ID 在前端自行计算，多用户下会冲突。
- 没有登录会话、当前用户、任务所有权和 can_edit 信息。

当前 vue/src/App.vue 是单页组件，没有 Vue Router，也没有个人任务页和登录页。

## 6. 目标架构

建议将后端从单文件拆成以下模块：

~~~text
vue/
├── server.cjs                         # 进程启动、资源关闭
├── server/
│   ├── app.cjs                        # Express 应用装配
│   ├── config.cjs                     # 环境变量读取与校验
│   ├── db/
│   │   ├── pool.cjs                   # PostgreSQL Pool
│   │   ├── usersRepository.cjs
│   │   ├── tasksRepository.cjs
│   │   ├── executionsRepository.cjs
│   │   └── auditRepository.cjs
│   ├── middleware/
│   │   ├── requireSession.cjs
│   │   ├── requireTaskOwner.cjs
│   │   └── errorHandler.cjs
│   ├── routes/
│   │   ├── auth.cjs
│   │   ├── tasks.cjs
│   │   ├── imports.cjs
│   │   └── yingdao.cjs
│   └── services/
│       ├── yingdaoClient.cjs
│       ├── syncCoordinator.cjs
│       ├── executionStatus.cjs
│       ├── taskMutationService.cjs
│       └── retentionService.cjs
└── src/
    ├── router.js
    ├── pages/
    │   ├── LoginPage.vue
    │   ├── SchedulePage.vue
    │   └── MyTasksPage.vue
    ├── components/
    │   ├── SchedulePicker.vue
    │   ├── ExecutionHistoryDialog.vue
    │   └── JobLogsDialog.vue
    └── services/
        ├── apiClient.js
        ├── authService.js
        ├── taskService.js
        └── yingdaoService.js
~~~

数据流：

~~~text
浏览器
  → 登录会话
  → Express 权限中间件
  → 任务/影刀服务
  → PostgreSQL
  → 影刀开放 API

影刀定时同步
  → 增量执行记录
  → 状态归一化
  → PostgreSQL
  → 页面每 10 秒读取数据库
~~~

生产环境只部署一个应用实例，因此同步协调器、短期日志缓存和同任务运行锁可放在进程内；数据唯一性、事务和版本冲突仍必须依赖 PostgreSQL。

## 7. 数据库设计

### 7.1 app_users

用途：保存开发用户和未来飞书用户。

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | BIGINT IDENTITY | 内部用户主键 |
| display_name | TEXT | 展示名称 |
| avatar_url | TEXT | 可空 |
| auth_provider | TEXT | dev 或 feishu |
| feishu_open_id | TEXT | 可空，飞书接入后使用 |
| feishu_union_id | TEXT | 可空 |
| feishu_tenant_key | TEXT | 可空 |
| is_active | BOOLEAN | 是否允许登录 |
| created_at | TIMESTAMPTZ | 创建时间 |
| updated_at | TIMESTAMPTZ | 更新时间 |
| last_login_at | TIMESTAMPTZ | 最后登录时间 |

约束：

- 飞书身份字段在非空时建立唯一索引。
- display_name 不唯一。
- 停用用户不能新建会话，但其历史任务和执行记录继续保留。

### 7.2 rpa_tasks

保留原有字段并扩展：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | BIGINT IDENTITY | 服务端生成 |
| task | TEXT | 沙盘任务名称 |
| start_time | VARCHAR(8) | HH:MM:SS |
| finish_time | VARCHAR(8) | HH:MM:SS |
| bot | TEXT | 沙盘 Bot |
| created_by_user_id | BIGINT | 创建者，可空以兼容历史 |
| owner_user_id | BIGINT | 当前所有者，可空以兼容历史 |
| schedule_uuid | TEXT | 当前影刀计划，可空以兼容历史 |
| schedule_bound_at | TIMESTAMPTZ | 当前绑定生效时间 |
| tags | TEXT[] | 多个自由标签 |
| note | TEXT | 备注 |
| version | INTEGER | 乐观锁版本，从 1 开始 |
| last_synced_at | TIMESTAMPTZ | 最近成功同步时间 |
| sync_error | TEXT | 最近同步错误 |
| created_at | TIMESTAMPTZ | 创建时间 |
| updated_at | TIMESTAMPTZ | 更新时间 |
| deleted_at | TIMESTAMPTZ | 软删除时间 |

关键约束和索引：

- 对未删除且 schedule_uuid 非空的记录建立部分唯一索引。
- owner_user_id 建立普通索引。
- tags 建立 GIN 索引。
- deleted_at 建立索引。
- 时间字段保留现有跨天语义：finish_time 小于 start_time 时视为次日结束。
- 新建 API 强制 owner_user_id 和 schedule_uuid 非空；数据库字段在历史迁移期间保持可空。

### 7.3 rpa_task_executions

用途：保存最近 30 天真实执行记录。

建议字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| task_uuid | TEXT PRIMARY KEY | 影刀执行唯一标识 |
| rpa_task_id | BIGINT | 归属平台任务 |
| schedule_uuid_at_run | TEXT | 运行时计划标识 |
| normalized_status | TEXT | 平台归一化状态 |
| raw_status | TEXT | 影刀原始状态 |
| raw_status_name | TEXT | 影刀原始状态名称 |
| trigger_time | TIMESTAMPTZ | 触发时间 |
| updated_time | TIMESTAMPTZ | 更新时间 |
| end_time | TIMESTAMPTZ | 结束时间 |
| job_uuid_list | JSONB | 应用运行 UUID 集合 |
| source_type | TEXT | API、调度等 |
| clients | JSONB | 实际机器人信息 |
| error_remark | TEXT | 原始错误原因 |
| synced_at | TIMESTAMPTZ | 同步时间 |

关键索引：

- rpa_task_id + trigger_time DESC。
- schedule_uuid_at_run + trigger_time DESC。
- normalized_status 的活动状态部分索引。
- end_time 或 trigger_time 索引用于 30 天清理。

执行记录以 task_uuid 幂等写入。重复同步只更新状态和时间，不插入第二条记录。

### 7.4 rpa_task_binding_history

用途：记录每一次绑定区间，支持换绑后的历史归属判断。

字段至少包括：

- id
- rpa_task_id
- schedule_uuid
- bound_at
- unbound_at
- actor_user_id
- created_at

换绑时必须在同一事务中关闭旧区间、写入新区间并更新 rpa_tasks 当前绑定。

### 7.5 rpa_task_audit_log

记录以下动作：

- create
- update
- delete
- rebind
- transfer
- import
- run_now

字段至少包括 task_id、actor_user_id、action、old_value JSONB、new_value JSONB、created_at。

### 7.6 会话存储

不使用 Express 默认 MemoryStore。建议使用 PostgreSQL 会话存储，使开发重启和未来飞书登录可复用相同会话模型。

可采用 express-session + connect-pg-simple，Cookie 至少设置：

- httpOnly
- sameSite=lax
- 生产环境 secure=true
- 合理的 maxAge

## 8. 数据库迁移策略

建议引入有序 SQL 迁移，而不是继续只维护一份 schema.sql。

~~~text
storage/
├── migrations/
│   ├── 001_add_users_and_task_ownership.sql
│   ├── 002_add_executions_and_binding_history.sql
│   ├── 003_add_audit_and_sessions.sql
│   └── 004_remove_legacy_storage_assumptions.sql
└── schema.sql
~~~

迁移步骤：

1. 对生产数据库做完整备份。
2. 新增 app_users、执行记录、绑定历史、审计和会话表。
3. 对 rpa_tasks 增加可空字段，不删除原始任务。
4. 把原 id 升级或兼容为 BIGINT。
5. 建立部分唯一索引和查询索引。
6. 发布支持历史未绑定任务只读的应用版本。
7. 由用户手工补充历史记录的 owner_user_id 和 schedule_uuid。
8. 运行校验 SQL，确认不存在重复 schedule_uuid。
9. 文件存储代码退出运行路径。

应用启动时只检查数据库迁移版本，不自动执行生产 DDL。数据库版本落后时应拒绝启动并给出明确提示。

## 9. 登录与鉴权设计

### 9.1 开发模式

环境变量 AUTH_MODE=dev 时：

- GET /api/auth/dev/users 返回可切换的有效开发用户。
- POST /api/auth/dev/switch 接收 user_id，校验用户存在后写入会话。
- POST /api/auth/logout 清理会话。
- GET /api/auth/session 返回当前用户。

生产环境若检测到 AUTH_MODE=dev，应显式拒绝启动或至少要求额外的开发开关，避免误开放身份切换。

### 9.2 飞书预留

未来接入飞书 OAuth 后：

1. OAuth 回调获得飞书稳定身份。
2. 按 tenant_key + open_id 或 union_id 查找 app_users。
3. 首次登录自动创建用户。
4. 更新姓名、头像和 last_login_at。
5. 写入与开发模式相同的 session.user_id。

任务权限层不感知身份提供方，只读取 session.user_id。

### 9.3 权限中间件

至少提供：

- requireSession：拒绝匿名业务请求。
- requireTaskOwner：从数据库读取任务并比较 owner_user_id。
- requireActiveTask：拒绝对软删除任务操作。

owner_user_id 不得从客户端请求体直接信任。创建、导入时统一由服务端写入当前 user_id。

## 10. API 设计

### 10.1 任务读取

#### GET /api/tasks

返回所有未删除任务，包括尚未绑定的历史任务。

每条任务补充：

- owner 基本信息
- created_by 基本信息
- can_edit
- is_legacy_unbound
- version
- tags
- 当前汇总状态
- last_run_at
- last_synced_at
- sync_error

#### GET /api/my/tasks

只返回 owner_user_id 等于当前用户且未删除、已绑定 scheduleUuid 的任务。

支持参数：

- query
- tags
- normalized_status
- sort

### 10.2 显式保存

保留用户点击“保存”后才写入数据库的交互，但接口改为差异批量提交。

建议接口：

#### POST /api/tasks/batch

请求体由 mutations 数组组成：

- create：包含客户端临时 ID 和完整新任务字段。
- update：包含 id、version 和修改字段。
- delete：包含 id 和 version。

后端处理顺序：

1. 开启事务。
2. 校验所有 mutation 的结构。
3. 对 update 和 delete 逐条校验所有权。
4. 校验 version 未变化。
5. 校验 scheduleUuid 唯一且计划存在于可信缓存或实时接口中。
6. 执行全部写入。
7. 任一项失败则整批回滚。
8. 返回服务端正式 ID、最新 version 和标准化任务对象。

前端必须维护 dirtyTasks 或 mutations，不得再发送完整任务列表。

### 10.3 任务操作

- POST /api/tasks/:id/rebind：立即换绑，记录绑定历史并重置当前汇总状态。
- POST /api/tasks/:id/transfer：立即转交所有权并记录审计。
- DELETE /api/tasks/:id：软删除；也可作为 batch delete 的内部实现。
- POST /api/tasks/:id/run：立即执行。
- POST /api/tasks/:id/sync：刷新单任务。

换绑、转交和立即执行具有外部或权限副作用，应在用户确认后立即提交，不进入普通沙盘草稿。

### 10.4 计划选择器

#### GET /api/yingdao/schedules

支持：

- query：按计划名称或 scheduleUuid 搜索。
- page、size：分页。
- include_bound：是否显示已绑定计划。

返回：

- schedule_uuid
- schedule_name
- bound
- bound_task_id
- bound_task_name
- bound_owner

默认只展示未绑定计划；搜索命中已绑定计划时可返回置灰项并说明当前归属。

计划列表缓存 60 秒。影刀不可用时，只允许使用最近 5 分钟内的可信缓存完成绑定；没有可信缓存则阻止新建或换绑。

### 10.5 同步、执行和日志

- POST /api/my/tasks/sync：同步当前用户全部已绑定任务，重复请求合并。
- GET /api/tasks/:id/executions：任意登录用户可查看。
- GET /api/executions/:taskUuid/jobs：查询任务内应用执行明细。
- GET /api/jobs/:jobUuid/logs：按需查询日志并缓存 5 分钟。

### 10.6 导入导出

导入只允许新增，不允许覆盖、删除或修改已有任务。

导入字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| Task | 是 | 任务名称 |
| Start | 是 | HH:MM:SS |
| Finish | 是 | HH:MM:SS |
| Bot | 是 | 沙盘 Bot |
| ScheduleUuid | 是 | 唯一影刀计划 |
| Tags | 否 | CSV 使用英文分号分隔；JSON 使用字符串数组 |
| Note | 否 | 备注 |

导入记录的 created_by_user_id 和 owner_user_id 均由服务端写入当前用户。

导出包含沙盘任务、所有者、scheduleUuid、标签和备注，不包含执行历史及日志。

旧四列文件不能通过普通导入创建未绑定任务；历史数据由数据库迁移处理。

## 11. 影刀 API 客户端

后端统一使用一套企业凭证：

- YINGDAO_ACCESS_KEY_ID
- YINGDAO_ACCESS_KEY_SECRET
- YINGDAO_BASE_URL，默认 https://api.yingdao.com

凭证和 accessToken 永不返回前端，不写入普通日志或错误响应。

### 11.1 Token

- 通过 token/create 接口获取 accessToken。
- 按 expiresIn 缓存，提前 60 秒视为过期。
- 遇到 401 时强制刷新一次并重试原请求。
- 同一时刻只允许一个 Token 刷新请求，其他调用等待同一个 Promise。

### 11.2 使用接口

- /oapi/dispatch/v2/schedule/list
- /oapi/dispatch/v2/schedule/detail
- /oapi/dispatch/v2/task/newest/list
- /oapi/dispatch/v2/task/list
- /oapi/dispatch/v2/task/start
- /oapi/dispatch/v2/task/query
- /oapi/dispatch/v2/task/process/detail
- /oapi/dispatch/v2/job/log/search

### 11.3 限流与重试

必须建立全局调用调度器，调用频率低于影刀官方限制：

- task/newest/list：不超过 5 次/秒。
- task/list、task/query、task/start：不超过 10 次/秒。
- job/log/search：不超过 5 次/秒。

建议将全局实际速率控制在官方上限的 80% 左右，并实现：

- 429：指数退避加随机抖动。
- 网络超时和 5xx：有限次数重试。
- 400 和业务校验错误：不重试。
- 所有请求设置超时。
- 日志中清理 Authorization、accessKeySecret 和 Token。

## 12. 同步与状态模型

### 12.1 同步策略

- 服务启动后异步执行一次恢复同步，不阻塞健康检查过久。
- 后端每 60 秒执行全局增量同步。
- 页面每 10 秒从本地数据库刷新。
- 用户手动同步时，同步当前用户全部已绑定任务。
- 同一用户短时间重复同步请求合并处理。
- 执行记录保留 30 天，每日运行清理任务。
- 同步失败不覆盖已有有效状态，只更新 sync_error 和数据截至时间。

绑定或换绑后，允许通过 task/list 回填，但必须过滤 trigger_time 早于 schedule_bound_at 的记录。

### 12.2 运行轮询

立即执行成功后：

1. 使用随机 UUID 作为 idempotentUuid。
2. 立刻保存返回的 taskUuid 和 jobUuidList。
3. 初始状态写为等待中。
4. 前 2 分钟以约 5 秒为目标间隔查询。
5. 后续根据运行时长降低到约 15～30 秒。
6. 全局限流优先于单任务目标间隔。
7. 进入终态后停止轮询。
8. 服务重启后从数据库恢复等待中和运行中的执行记录。

单实例环境可使用进程内 Map 防止同一任务重复启动；同时仍需在数据库事务中锁定任务行并再次查询活动执行记录，避免双击请求穿透。

### 12.3 状态映射

| 原始状态或条件 | 平台状态 |
|---|---|
| created、pending、waiting、queued、dispatching | 等待中 |
| running、executing | 运行中 |
| 等待机器人后超时 | 等待超时 |
| 应用开始运行后超时 | 运行超时 |
| finish、success | 运行成功 |
| error、failed、fail，以及无法细分的 timeout | 运行失败 |
| stopped、stop、cancelled、canceled | 已停止 |
| 未识别状态 | 未知状态 |
| 无任何执行记录 | 待运行 |

等待超时和运行超时优先依据影刀 statusName、errorRemark 和返回的阶段信息判断。若无法可靠区分，保留原始文本并落为运行失败或未知状态，不凭空猜测。

### 12.4 多执行实例汇总

同一平台任务可能同时存在多个影刀执行实例，汇总规则为：

1. 任一实例为运行中，则任务显示运行中。
2. 否则任一实例为等待中，则任务显示等待中。
3. 否则显示最近结束实例的终态。
4. 没有记录则显示待运行。

立即执行前，只要存在等待中或运行中实例，就拒绝启动。

## 13. 前端改造

### 13.1 路由

引入 Vue Router：

- /login：开发用户选择页，未来替换飞书登录。
- /schedule：主甘特图。
- /my-tasks：个人任务页。
- /：按会话状态跳转；已登录默认进入 /schedule。

API 返回 401 时，前端统一清理当前会话状态并跳转 /login。

### 13.2 主甘特图

保留现有时间轴和 Bot 配色，并增加：

- 所有者列。
- 所有者筛选。
- Tooltip 显示所有者。
- 他人任务显示锁定状态。
- 他人任务不可拖拽、不可编辑、不可删除。
- 自己的任务保持现有拖拽和编辑能力。
- 未绑定历史任务显示“待绑定/只读”标记。

颜色继续按 Bot 分配，不按所有者配色。

### 13.3 草稿和保存

将当前全局 hasUnsavedChanges 布尔值升级为：

- 原始已保存快照。
- 当前草稿任务。
- 按任务 ID 维护的 mutation 集合。
- 新任务使用客户端临时 ID。

点击保存时只发送 mutation 集合。保存成功后用服务端返回的正式对象替换草稿；若发生版本或计划唯一性冲突，整批保持未保存状态并提示冲突任务。

刷新按钮继续表示丢弃本地草稿并重新读取数据库。

### 13.4 个人任务页

个人页使用单一平铺表，不按标签重复分组。

列：

- 任务名称
- 标签
- 起止时间
- Bot
- 最新状态
- 最后运行
- 备注
- 操作

功能：

- 关键词搜索。
- 多标签筛选。
- 状态筛选。
- 新建和编辑。
- 软删除。
- 换绑计划。
- 转交所有权。
- 立即执行。
- 查看执行记录。
- 查看应用执行明细和日志。
- 同步我的任务。
- 显示数据截至时间和同步错误。

### 13.5 计划选择器

两个页面复用 SchedulePicker：

- 支持名称和 UUID 搜索。
- 支持分页和加载状态。
- 默认显示未绑定计划。
- 已绑定计划置灰并显示所属任务和所有者。
- 网络失败时说明是否正在使用缓存。
- 新建表单中 scheduleUuid 必填。

## 14. 配置调整

删除或停止使用：

- STORAGE_DRIVER
- TASKS_FILE
- 文件数据兜底配置

新增建议配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| DATABASE_URL | 无 | 可选；非空时优先于拆分的 PG 配置 |
| PGHOST | 无 | 未设置 DATABASE_URL 时必填 |
| PGPORT | 5432 | 未设置 DATABASE_URL 时必填 |
| PGDATABASE | 无 | 未设置 DATABASE_URL 时必填 |
| PGUSER | 无 | 未设置 DATABASE_URL 时必填 |
| PGPASSWORD | 无 | 未设置 DATABASE_URL 时必填 |
| AUTH_MODE | dev | dev 或 feishu |
| SESSION_SECRET | 无 | 必填 |
| SESSION_MAX_AGE_SECONDS | 28800 | 会话有效期 |
| YINGDAO_ACCESS_KEY_ID | 无 | 必填 |
| YINGDAO_ACCESS_KEY_SECRET | 无 | 必填 |
| YINGDAO_BASE_URL | https://api.yingdao.com | API 地址 |
| YINGDAO_SYNC_INTERVAL_SECONDS | 60 | 增量同步周期 |
| YINGDAO_SCHEDULE_CACHE_SECONDS | 60 | 计划列表缓存 |
| YINGDAO_BIND_CACHE_MAX_AGE_SECONDS | 300 | 允许绑定的缓存最大年龄 |
| EXECUTION_RETENTION_DAYS | 30 | 执行记录保留天数 |
| JOB_LOG_CACHE_SECONDS | 300 | 日志缓存时间 |
| UI_REFRESH_SECONDS | 10 | 页面数据库刷新周期 |

公网部署时 CORS_ORIGIN 必须设置为明确白名单，并启用安全 Cookie。跨域开发环境若需要携带会话 Cookie，服务端必须启用 credentials，前端请求也必须显式发送 credentials；生产环境优先采用前后端同源部署。

## 15. 依赖调整

后端建议增加：

- express-session
- connect-pg-simple
- 用于全局限流的轻量库，或实现内部调度器
- 用于请求参数校验的 schema 库，例如 zod

前端建议增加：

- vue-router

测试建议增加：

- vitest
- supertest
- @vue/test-utils

不引入 Python、openpyxl 或第二套后台任务服务。

## 16. 测试计划

### 16.1 权限

- 匿名请求业务 API 返回 401。
- 用户可以读取全部主页面任务。
- 个人页只返回自己的任务。
- 用户不能通过直接构造 API 修改他人任务。
- 用户不能拖拽或编辑他人任务。
- 执行记录、日志和导出对任意登录用户可见。
- 开发切换接口在非 dev 模式不可用。

### 16.2 保存与并发

- 保存只发送有变化的任务。
- 批量保存任一任务无权或版本冲突时全部回滚。
- 两个用户同时绑定同一 scheduleUuid，只有一个成功。
- 前端临时 ID 正确替换为数据库 ID。
- 刷新可以丢弃未保存修改。

### 16.3 绑定与历史

- 新任务缺少 scheduleUuid 时拒绝保存。
- 历史未绑定任务主页面可见但只读。
- 换绑保留旧执行历史。
- 新绑定不接收 bound_at 之前的记录。
- 释放后的 scheduleUuid 可以被其他任务绑定。
- 软删除释放计划但不调用影刀删除接口。

### 16.4 转交

- 只有当前所有者可以转交。
- 转交后旧所有者立即失去写权限。
- 新所有者获得写权限。
- created_by_user_id 不变化。
- 绑定和历史不变化。
- 审计记录完整。

### 16.5 影刀客户端

- Token 正常缓存。
- Token 临近过期时刷新。
- 401 只刷新重试一次。
- 429 按退避规则处理。
- 密钥和 Token 不进入日志或响应。
- API 超时不覆盖上次有效状态。

### 16.6 同步与状态

- taskUuid 重复同步不产生重复记录。
- 等待中与运行中正确区分。
- 等待超时与运行超时尽可能正确区分。
- 多实例汇总优先级正确。
- 存在活动实例时立即执行被拒绝。
- 服务重启后恢复活动记录轮询。
- 30 天清理不删除仍在保留期内的数据。

### 16.7 前端

- 路由登录守卫正确。
- 主页面锁定他人任务。
- 个人页标签筛选不重复任务。
- 数据截至时间和错误提示可见。
- 桌面和窄屏页面无整体横向溢出。
- 甘特图内部横向滚动和拖拽行为保持正常。

## 17. 分阶段实施

### 阶段一：数据库与 PostgreSQL 单一数据源

任务：

- 新增迁移体系和目标表结构。
- 移除 storage driver 运行时切换。
- 删除前端 tasks.json 兜底。
- 改造 PostgreSQL repository。

验收：

- DATABASE_URL 非空时直接使用；否则根据完整的 PGHOST、PGPORT、PGDATABASE、PGUSER、PGPASSWORD 自动生成连接串。
- DATABASE_URL 和完整五项 PG 配置都缺失时服务拒绝启动。
- 历史任务无损读取。
- 未绑定历史任务可识别。

### 阶段二：登录与权限

任务：

- 实现 app_users、PG Session 和开发用户切换。
- 增加统一鉴权和所有权校验。
- 前端增加 /login 和会话状态。

验收：

- 所有业务 API 受保护。
- 用户无法修改他人任务。

### 阶段三：差异保存与主页面改造

任务：

- 将整表保存替换为 mutation 批量事务。
- 增加 version。
- 主页面增加所有者展示、筛选和锁定。
- 改造导入导出。

验收：

- 保留显式保存体验。
- 不再出现跨用户整表覆盖。

### 阶段四：影刀客户端与执行数据

任务：

- 实现 Token、限流、重试和接口封装。
- 实现计划选择器接口。
- 实现绑定、换绑和执行历史。
- 实现定时同步、手动同步和保留期清理。

验收：

- 100+ 任务下不超过接口限流。
- 状态和历史能稳定恢复。

### 阶段五：个人任务页与运行操作

任务：

- 新增 /my-tasks。
- 增加标签筛选、状态、历史、日志和数据截至时间。
- 实现立即执行、并发阻止和轮询。
- 实现任务转交与审计。

验收：

- 用户只在个人页看到自己的任务。
- 执行、日志和状态完整可用。

### 阶段六：迁移、压测和上线

任务：

- 执行生产备份和数据库迁移。
- 用户手工补充历史任务的所有者及 scheduleUuid。
- 使用 Fake Yingdao Client 完成自动化测试。
- 在真实环境只读验证计划、历史和日志。
- 经明确授权后验证一条测试计划的立即执行。
- 完成构建、Docker 和移动端检查。

验收：

- 无重复 scheduleUuid。
- 无未授权写入。
- 同步、保存和重启恢复符合要求。
- 回滚脚本和上线检查清单可用。

## 18. 风险接受

以下风险已由产品决策接受：

1. 不校验绑定者是否为影刀计划真实创建者。
2. 不设置管理员角色。
3. 任意已登录用户可以查看全员任务、执行记录和日志。
4. 误绑只能由当前所有者自行释放或由运维直接修改数据库。
5. 第一版只支持单应用实例。
6. 影刀状态枚举可能变化，因此必须保留原始状态并对未知值保守处理。

## 19. 完成标准

满足以下条件才算完成：

- PostgreSQL 是唯一运行时数据源。
- 三个路由 /login、/schedule、/my-tasks 可正常使用。
- 开发用户切换和会话鉴权完整。
- 主页面全员可见、仅所有者可写。
- 个人页严格按 owner_user_id 返回数据。
- 新任务必须绑定唯一 scheduleUuid。
- 执行状态、30 天历史、日志、同步和立即执行可用。
- 等待、运行和超时状态可以区分。
- 换绑、软删除和转交行为符合本文规则。
- 显式保存不再发送整张任务表。
- 关键后端与前端流程有自动化测试。
- 构建成功，桌面与移动端布局通过检查。
- 凭证、Token 和敏感配置未出现在前端、日志、测试夹具或提交内容中。
