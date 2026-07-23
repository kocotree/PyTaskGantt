# PyTaskGantt 管理员权限设计方案

> 状态：已实现，待按上线方案部署  
> 目标版本：数据库 Schema Version 7  
> 适用系统：Vue 3 + Express 5 + PostgreSQL 版本的 PyTaskGantt

实现验证（2026-07-23）：`npm test`、`npm run build`、Schema 1→7 真实 PostgreSQL 迁移和双用户管理员权限集成测试均已通过。

## 1. 背景

当前系统采用严格的任务所有者权限模型：任意已登录用户可以查看全员任务、执行记录、作业和日志，但编辑、删除、拖拽、换绑、转交、立即执行和单任务同步仅允许当前任务所有者执行。

这一模型可以防止普通用户越权修改他人任务，但缺少能够处理以下场景的管理员身份：

- 统一维护所有用户的排班任务；
- 在用户离职、账号异常或飞书身份重复时转交任务；
- 修复历史未归属、未绑定的只读任务；
- 协助用户换绑影刀计划、同步或执行任务；
- 在保留真实操作者审计记录的前提下进行运维处理。

本方案在现有所有者权限模型上增加轻量级管理员标记，不引入完整 RBAC 系统。

## 2. 设计目标

1. 在 `app_users` 中持久化管理员权限。
2. 普通用户权限和现有安全边界保持不变。
3. 管理员可以操作任意有效任务，但不自动改变任务所有者。
4. 管理员可以通过专用流程恢复历史未归属或未绑定任务。
5. 所有管理员操作记录真实管理员身份，不模拟其他用户。
6. 管理员权限只能通过受控运维方式授予或撤销。
7. 保留乐观锁、事务回滚、影刀计划唯一绑定和绑定历史等现有约束。

## 3. 非目标

本期不包含：

- 完整的角色和权限管理系统；
- 自定义角色或逐项权限配置；
- 普通用户通过页面申请管理员权限；
- 管理员模拟登录为其他用户；
- 软删除任务恢复；
- 批量强制删除或绕过乐观锁；
- 按用户名、显示名称、飞书昵称或环境变量识别管理员；
- 使用 `auth_provider` 表示管理员权限。

## 4. 数据模型

### 4.1 管理员字段

追加迁移文件：

```text
storage/migrations/007_add_admin_permission.sql
```

迁移增加以下字段：

```sql
ALTER TABLE public.app_users
ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;
```

设计原则：

- 现有用户迁移后默认为普通用户；
- 新建 dev 或飞书用户默认不是管理员；
- `is_admin` 与登录来源无关；
- 一个 dev 用户或飞书用户都可以被授予管理员权限；
- 不允许客户端在创建或更新用户时提交该字段。

### 4.2 审计动作

管理员处理历史任务需要新增审计动作：

```text
admin_recover
```

迁移 `007` 同步更新 `ck_rpa_task_audit_log_action`，允许该动作进入审计表。

已有 `001-006` 迁移不得修改。实现时需要同步更新：

- `storage/schema.sql`；
- migration checksum；
- `server/db/migrations.cjs` 的最新版本；
- `storage/operations/verify.sql`；
- migration、snapshot 和 verify 测试。

## 5. 权限模型

### 5.1 权限矩阵

| 操作 | 普通用户 | 管理员 |
|:---|:---:|:---:|
| 查看全员任务和执行历史 | 允许 | 允许 |
| 查看“我的任务” | 仅自己的任务 | 仍仅自己的任务 |
| 新建或导入任务 | 允许，任务归自己 | 允许，任务默认仍归自己 |
| 编辑或拖拽有效任务 | 仅自己的任务 | 任意有效任务 |
| 删除有效任务 | 仅自己的任务 | 任意有效任务 |
| 换绑影刀计划 | 仅自己的任务 | 任意有效任务 |
| 转交任务 | 仅自己的任务 | 任意有效任务 |
| 单任务同步 | 仅自己的任务 | 任意有效任务 |
| 立即执行 | 仅自己的任务 | 任意有效任务 |
| 恢复历史未归属或未绑定任务 | 禁止 | 允许 |
| 授予或撤销管理员权限 | 禁止 | 页面和公开 API 均不提供 |

### 5.2 管理员操作语义

管理员操作其他用户任务时：

- 管理员是操作者，任务原所有者保持不变；
- 普通编辑、拖拽、删除、换绑、同步和执行不改变 `owner_user_id`；
- 只有明确执行“转交”时才改变任务所有者；
- 审计记录使用管理员自己的 `actor_user_id`；
- 不创建模拟用户会话；
- 不允许绕过任务版本校验；
- 不允许直接操作已软删除任务。

## 6. 后端身份上下文

### 6.1 会话用户

会话仍只保存内部用户 ID：

```js
req.session.userId
```

`requireSession` 每次请求根据该 ID 从 PostgreSQL 加载有效用户，并生成可信操作者上下文：

```js
req.actor = {
  userId: '123',
  isAdmin: true,
}
```

管理员状态必须来自数据库，不能来自：

- 请求 body；
- query 参数；
- Cookie 自定义字段；
- 前端状态；
- 飞书用户资料；
- 显示名称。

用户被停用或撤销管理员权限后，应从下一次 API 请求开始立即失效，无需等待当前 session 过期。

### 6.2 服务调用调整

当前仅传递 `userId` 的写服务应调整为传递操作者上下文：

```js
{
  userId,
  isAdmin,
}
```

涉及范围：

- `taskMutationService.applyBatch`；
- `taskActionService.rebind`；
- `taskActionService.transfer`；
- `taskActionService.runNow`；
- 单任务同步；
- 删除任务兼容接口；
- 管理员历史任务恢复服务。

## 7. 常规任务权限实现

### 7.1 查询权限

任务列表中的 `can_edit` 调整为：

```text
任务未删除
且任务拥有有效所有者和计划绑定
且当前用户是任务所有者或管理员
```

历史未归属或未绑定任务仍不能通过普通编辑接口修改，即使当前用户是管理员，也必须进入专用恢复流程。

### 7.2 Mutation 权限

`POST /api/tasks/batch` 保留现有行为：

- create：新任务仍归当前操作者；
- update：所有者或管理员可更新允许的普通字段；
- delete：所有者或管理员可软删除任务；
- 普通 update 仍不得修改所有者和计划绑定；
- 每项仍锁行并校验 `version`；
- 任一 mutation 失败时整批回滚。

SQL 和服务层权限条件等价于：

```text
owner_user_id = actor.userId OR actor.isAdmin = true
```

不能只依赖前端传入的 `can_edit`。

### 7.3 专用任务动作

以下动作允许所有者或管理员执行：

- 换绑；
- 转交；
- 立即执行；
- 单任务同步。

动作仍必须满足原有业务约束，例如：

- 任务未删除；
- 任务具有有效绑定；
- 影刀计划存在；
- 计划未被其他有效任务占用；
- 不存在同任务并发活动执行；
- 请求版本未冲突。

## 8. 历史任务恢复流程

### 8.1 使用场景

专用流程用于处理：

- `owner_user_id IS NULL`；
- `schedule_uuid IS NULL`；
- `schedule_bound_at IS NULL`；
- 因旧数据迁移而处于只读状态的任务。

普通任务的转交和换绑继续使用现有专用端点，不使用恢复接口。

### 8.2 管理员接口

新增接口：

```http
POST /api/admin/tasks/:id/recover
```

请求体：

```json
{
  "version": 1,
  "owner_user_id": "目标内部用户ID",
  "schedule_uuid": "影刀计划UUID"
}
```

`bound_at` 不由浏览器提交，使用服务端完成事务时的当前时间，避免客户端伪造绑定边界。

### 8.3 事务步骤

恢复操作必须在单一 PostgreSQL 事务内完成：

1. 校验操作者已登录且 `is_admin=true`；
2. 校验任务 ID 和请求字段格式；
3. 锁定目标任务行；
4. 校验任务未软删除；
5. 校验乐观锁版本；
6. 校验目标用户存在且 `is_active=true`；
7. 从影刀确认计划真实存在；
8. 校验计划未被其他有效任务占用；
9. 设置 `owner_user_id`；
10. 设置 `schedule_uuid` 和服务器当前 `schedule_bound_at`；
11. 新增活动 `rpa_task_binding_history`；
12. 任务 `version + 1`；
13. 写入 `admin_recover` 审计记录；
14. 提交事务。

任一步失败必须整笔回滚。

### 8.4 历史字段处理

- 不修改或伪造 `created_by_user_id`；
- 不为恢复时间之前的执行记录创建虚假归属；
- 新计划只接收恢复绑定时间之后的执行记录；
- 不允许恢复接口覆盖另一个任务的活动计划绑定；
- 如果任务已经是正常有效任务，应拒绝恢复并提示使用换绑或转交功能。

## 9. API 错误约定

管理员相关错误建议使用以下错误码：

| HTTP 状态 | 错误码 | 含义 |
|:---:|:---|:---|
| 401 | `AUTH_REQUIRED` | 未登录或 session 已失效 |
| 403 | `ADMIN_REQUIRED` | 当前用户不是管理员 |
| 404 | `NOT_FOUND` | 任务或目标用户不存在 |
| 409 | `VERSION_CONFLICT` | 任务版本已变化 |
| 409 | `SCHEDULE_ALREADY_BOUND` | 计划已绑定其他有效任务 |
| 409 | `TASK_ALREADY_ACTIVE` | 任务已是正常有效任务，不应恢复 |
| 400 | `VALIDATION_ERROR` | ID、版本或计划参数无效 |

错误响应不得暴露数据库 SQL、飞书凭证、影刀 Token 或 Access Key。

## 10. 前端设计

### 10.1 当前用户标识

会话接口为当前登录用户返回：

```json
{
  "is_admin": true
}
```

页头在用户名附近显示“管理员”标记。

是否展示其他用户的管理员状态不属于本期需求；用户列表接口可以不返回该字段。

### 10.2 常规任务

管理员看到的有效任务由服务端返回 `can_edit=true`，现有组件据此开放：

- 编辑；
- 拖拽；
- 删除；
- 换绑；
- 转交；
- 立即执行；
- 单任务同步。

前端不自行根据用户名判断管理员权限。

### 10.3 历史任务恢复

管理员查看历史只读任务时显示“分配并绑定”入口，普通用户仍显示只读提示。

恢复弹窗包括：

- 当前任务名称和 ID；
- 目标用户选择器；
- 影刀计划选择器；
- 当前任务版本；
- 绑定从当前时间生效的说明；
- 提交和取消操作。

恢复成功后刷新任务列表，任务应立即变为目标用户拥有的正常任务。

## 11. 管理员授予与撤销

第一版不提供网页端管理员管理功能，也不提供公开 API。

新增受控运维命令：

```bash
npm run admin:set -- --user-id <用户ID> --enabled true
npm run admin:set -- --user-id <用户ID> --enabled false
```

建议脚本位置：

```text
storage/setAdmin.cjs
```

脚本要求：

- 使用现有 PostgreSQL 配置；
- 校验数据库已经迁移至最新版本；
- 只接受精确内部用户 ID；
- 校验用户存在；
- 输出用户 ID、显示名称和最终管理员状态；
- 不输出飞书身份、数据库密码或其他凭证；
- 重复执行具有幂等性。

## 12. 审计设计

管理员执行普通任务动作时沿用现有审计动作，例如：

- `update`；
- `delete`；
- `rebind`；
- `transfer`；
- `run_now`。

审计 payload 增加：

```json
{
  "admin_override": true,
  "task_owner_user_id": "操作发生时的任务所有者ID"
}
```

管理员恢复历史任务时使用 `admin_recover`，至少记录：

- 操作者用户 ID；
- 任务 ID；
- 恢复前后的所有者；
- 恢复前后的计划 UUID；
- 生效绑定时间；
- 恢复前后的版本；
- 操作时间。

## 13. 安全要求

1. `is_admin` 只能从 PostgreSQL 读取。
2. 普通用户接口不得更新 `is_admin`。
3. 不使用环境变量管理员 ID 白名单。
4. 不使用显示名称或飞书昵称识别管理员。
5. 不允许管理员绕过乐观锁。
6. 不允许管理员绕过影刀计划唯一绑定。
7. 不允许管理员普通编辑时隐式修改所有者。
8. 不允许管理员把历史执行记录移动到新绑定。
9. 管理员被停用后，现有 session 下一次请求必须失效。
10. 管理员被撤销权限后，下一次请求必须按普通用户处理。
11. 所有管理员操作必须有服务端审计记录。
12. 前端按钮状态不能作为权限边界。

## 14. 测试方案

### 14.1 数据库和迁移

- migration 版本从 6 升级为 7；
- 旧用户自动获得 `is_admin=false`；
- 新用户默认 `is_admin=false`；
- schema snapshot checksum 与迁移一致；
- `verify.sql` 校验字段类型、非空和默认值；
- 审计动作约束允许 `admin_recover`。

### 14.2 后端权限

- 普通用户仍不能更新其他用户任务；
- 普通用户仍不能删除其他用户任务；
- 普通用户仍不能换绑、转交、同步或执行其他用户任务；
- 管理员可以完成上述操作；
- 管理员普通编辑不会改变任务所有者；
- 管理员操作仍校验任务版本；
- 管理员操作仍受计划唯一约束；
- 管理员不能操作已软删除任务；
- 撤销管理员权限后立即恢复普通用户边界。

### 14.3 历史任务恢复

- 普通用户调用恢复接口返回 403；
- 管理员可以恢复未归属、未绑定任务；
- 目标用户无效时整笔回滚；
- 影刀计划不存在时整笔回滚；
- 计划已占用时整笔回滚；
- 版本冲突时整笔回滚；
- 恢复后产生唯一活动 binding history；
- 恢复前的执行记录不会移动到新绑定；
- 正常有效任务不能通过恢复接口覆盖。

### 14.4 审计

- 管理员普通操作记录真实管理员 ID；
- `admin_override=true` 正确写入；
- 历史恢复写入 `admin_recover`；
- 审计失败导致业务事务回滚。

### 14.5 前端

- 普通用户界面保持现有按钮边界；
- 管理员看到全部有效任务的操作入口；
- 管理员看到历史任务恢复入口；
- 恢复弹窗正确提交用户、计划和版本；
- 403、409 和计划占用错误有明确提示；
- 页面轮询刷新不丢失本地草稿。

## 15. 实施范围

预计涉及以下模块：

```text
storage/migrations/007_add_admin_permission.sql
storage/schema.sql
storage/operations/verify.sql
storage/setAdmin.cjs
package.json
server/db/migrations.cjs
server/db/values.cjs
server/db/usersRepository.cjs
server/db/tasksRepository.cjs
server/middleware/requireSession.cjs
server/presenters.cjs
server/routes/tasks.cjs
server/routes/admin.cjs
server/services/taskMutationService.cjs
server/services/taskActionService.cjs
server/services/syncCoordinator.cjs
src/services/authService.js
src/services/taskService.js
src/components/AppShell.vue
src/pages/SchedulePage.vue
src/pages/MyTasksPage.vue
相关 backend、frontend、node:test 和 PostgreSQL 集成测试
```

实际实现时可以根据现有模块边界调整文件位置，但不得削弱后端权限校验。

## 16. 上线方案

### 16.1 上线前

1. 备份目标 PostgreSQL 数据库；
2. 确认当前 schema version 为 6；
3. 确定首个管理员的内部用户 ID；
4. 在测试环境验证普通用户和管理员权限矩阵；
5. 验证历史任务恢复和绑定区间语义。

### 16.2 部署顺序

```bash
cd vue
npm run migrate
npm run build
```

随后部署新应用，并授予管理员：

```bash
npm run admin:set -- --user-id <用户ID> --enabled true
```

### 16.3 上线验证

- `/api/health` 返回 schema version 7；
- 管理员可以编辑一条其他用户的测试任务；
- 操作后任务所有者没有变化；
- 普通用户操作同一任务返回 403；
- 管理员成功恢复一条测试历史任务；
- 审计表记录正确操作者和动作；
- 应用日志不包含数据库、飞书或影刀凭证。

## 17. 回滚考虑

`is_admin` 是向后兼容字段，旧版本应用会忽略该字段。应用版本回滚后：

- 管理员能力不可用；
- 普通所有者权限恢复为旧版本行为；
- 已完成的任务编辑、转交和历史恢复数据继续保留；
- 不删除 `is_admin` 字段或迁移历史；
- 不修改或回退已发布迁移 checksum。

如果管理员功能出现问题，应优先回滚应用版本并保留数据库 schema version 7，而不是直接删除字段或迁移记录。

## 18. 验收标准

方案实现完成需要同时满足：

1. 数据库中存在不可空、默认 false 的 `app_users.is_admin`；
2. 普通用户所有现有权限边界保持不变；
3. 管理员可以操作任意有效任务；
4. 管理员普通操作不改变任务所有者；
5. 历史任务只能通过管理员专用恢复流程处理；
6. 管理员操作完整写入审计；
7. 管理员权限只能通过受控运维方式授予；
8. 所有后端、前端、迁移和集成测试通过；
9. `npm test` 和 `npm run build` 通过；
10. 生产上线清单完成并经过双用户权限验证。
