# 上线与回滚检查清单

## 上线前

- [ ] 进入维护窗口并停止旧版应用、同步器、定时任务及其他数据库写入方；查询 `pg_stat_activity`，逐个确认 `application_name` 为空或不在本次发布清单内的连接来源；记录 `rpa_tasks` 行数、最大 ID 和备份时间。若备份后仍出现新行或更新时间变化，立即停止迁移。
- [ ] 为新服务设置可识别的 `PGAPPNAME`，确保能与旧写入方、迁移和运维连接区分。
- [ ] 在运维主机安装兼容版本的 `psql`、`pg_dump`、`pg_restore`，显式导出 `DATABASE_URL` 或完整五项 `PG*`，并设置 `PGSSLMODE=verify-full`（私有 CA 同时设置绝对路径 `PGSSLROOTCERT`）；shell 脚本不会自动读取 `.env`，也不会把连接串放入 PostgreSQL 客户端命令参数。
- [ ] 使用 `storage/operations/backup.sh` 生成完整自定义格式备份，确认新备份未向组或其他用户开放权限，并在隔离数据库完成一次恢复演练。
- [ ] 确认运行环境为 Node.js 20.19+，`npm ci`、`npm test`、`npm run build` 全部通过。
- [ ] `CORS_ORIGIN` 只含精确 HTTPS origin（无 `*`、路径或查询参数），`SESSION_SECRET` 至少 32 位，并确认未提交真实影刀凭证。
- [ ] 生产环境未误开开发用户切换；若是受控试运行，已显式记录 `ALLOW_DEV_AUTH_IN_PRODUCTION` 风险和关闭日期。
- [ ] 用独立迁移 owner 执行 `npm run migrate`，再运行 `verify.sql`；随后执行 `grant-runtime-role.sql`，并确认其内置的 `verify-runtime-role.sql` 最小权限验证通过。应用连接不得使用迁移 owner。
- [ ] 迁移后再次核对任务行数和历史备份基线；新增行必须有明确来源，不能把仍在运行的旧写入方产生的数据误判为迁移结果。
- [ ] 用 `npm run backfill:task -- --task-id ... --owner-user-id ... --schedule-uuid ... --bound-at ...` 原子补齐历史任务所有者、绑定时间、绑定历史和审计；保留未补齐任务为只读历史数据。
- [ ] 用只读操作验证影刀计划列表、计划详情、执行历史、应用明细和日志。
- [ ] 只有在明确授权后，对专用测试计划验证一次“立即执行”。
- [ ] 检查 100+ 任务下的主页面、个人页、同步耗时和影刀限流日志。
- [ ] 检查桌面和窄屏布局；body 不应整体横向滚动，甘特图与表格允许组件内部滚动。

## 发布后

- [ ] `/api/health` 返回 PostgreSQL schema version 6。
- [ ] `pg_stat_activity` 中新服务连接均显示预期 `PGAPPNAME`，且没有未知或遗留写入方重新出现。
- [ ] 匿名访问业务 API 返回 401，开发切换接口符合当前 `AUTH_MODE`。
- [ ] 飞书授权回调 URL 与 `FEISHU_REDIRECT_URI` 完全一致；验证登录、现有用户主动绑定、错误 state、租户白名单和 `FEISHU_AUTO_PROVISION` 策略。
- [ ] 用两个用户验证跨用户 update/delete/rebind/transfer/run 均被后端拒绝。
- [ ] 验证差异保存、版本冲突整批回滚、scheduleUuid 唯一约束和软删除释放计划。
- [ ] 验证启动恢复同步、活动执行恢复轮询、每日 30 天记录清理和五分钟日志缓存。
- [ ] 检查应用日志没有 Authorization、accessKeySecret、accessToken 或数据库密码。

## 回滚

1. 停止应用及所有同步/轮询实例。
2. 保留故障现场日志和当前数据库的额外备份。
3. 设置 `CONFIRM_RESTORE=RESTORE_BACKUP`，使用 `storage/operations/rollback.sh` 在单一事务中恢复上线前备份；任一对象恢复失败时整次恢复回滚。
4. 部署与该备份 schema 匹配的旧应用版本。
5. 重新执行只读校验后再开放流量。

迁移包含数据结构和身份/绑定语义变化，不提供“直接 DROP 新表/列”的原地降级；可靠回滚边界是上线前完整备份。
