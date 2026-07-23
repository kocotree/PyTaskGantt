#!/usr/bin/env node

const { getConfig } = require('../server/config.cjs');
const { createPool, withTransaction } = require('../server/db/pool.cjs');
const { assertLatestSchema } = require('../server/db/migrations.cjs');
const { isValidBigintId } = require('../server/services/taskValidation.cjs');

function optionValue(argv, flag, env, envName) {
  const index = argv.indexOf(flag);
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少参数值`);
    return value;
  }
  return env[envName];
}

function parseArguments(argv = process.argv.slice(2), env = process.env) {
  const taskId = optionValue(argv, '--task-id', env, 'BACKFILL_TASK_ID');
  const ownerUserId = optionValue(argv, '--owner-user-id', env, 'BACKFILL_OWNER_USER_ID');
  const actorUserId = optionValue(argv, '--actor-user-id', env, 'BACKFILL_ACTOR_USER_ID') || ownerUserId;
  const scheduleUuid = String(
    optionValue(argv, '--schedule-uuid', env, 'BACKFILL_SCHEDULE_UUID') || ''
  ).trim();
  const boundAtText = optionValue(argv, '--bound-at', env, 'BACKFILL_BOUND_AT');

  for (const [label, value] of [
    ['task id', taskId],
    ['owner user id', ownerUserId],
    ['actor user id', actorUserId],
  ]) {
    if (!isValidBigintId(value)) throw new Error(`${label} 必须是 BIGINT 范围内的正整数`);
  }
  if (!scheduleUuid || scheduleUuid.length > 200) {
    throw new Error('schedule uuid 必须是 1-200 个字符');
  }

  let boundAt = null;
  if (boundAtText) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(boundAtText).trim())) {
      throw new Error('--bound-at 必须是带 Z 或 UTC 偏移的 ISO 8601 时间');
    }
    boundAt = new Date(boundAtText);
    if (Number.isNaN(boundAt.getTime())) throw new Error('--bound-at 不是有效时间');
  }

  return {
    taskId: String(taskId),
    ownerUserId: String(ownerUserId),
    actorUserId: String(actorUserId),
    scheduleUuid,
    boundAt,
  };
}

async function backfillLegacyTask(pool, input, { now = () => new Date() } = {}) {
  return withTransaction(pool, async client => {
    const { rows: taskRows } = await client.query(
      `SELECT id, owner_user_id, schedule_uuid, schedule_bound_at, deleted_at, version
         FROM public.rpa_tasks
        WHERE id = $1
        FOR UPDATE`,
      [input.taskId]
    );
    const current = taskRows[0];
    if (!current) throw new Error('任务不存在');
    if (current.deleted_at) throw new Error('已软删除任务不能补绑定');
    if (current.owner_user_id != null && String(current.owner_user_id) !== input.ownerUserId) {
      throw new Error('任务已有不同所有者；请使用应用内转交流程');
    }
    if (current.schedule_uuid && String(current.schedule_uuid) !== input.scheduleUuid) {
      throw new Error('任务已有不同计划；请使用应用内换绑流程');
    }

    const requiredUsers = [...new Set([input.ownerUserId, input.actorUserId])];
    const { rows: userRows } = await client.query(
      `SELECT id::text AS id
         FROM public.app_users
        WHERE id = ANY($1::bigint[]) AND is_active = TRUE`,
      [requiredUsers]
    );
    const activeUsers = new Set(userRows.map(row => String(row.id)));
    if (requiredUsers.some(id => !activeUsers.has(id))) {
      throw new Error('所有者或操作人不存在，或已停用');
    }

    const { rows: conflicts } = await client.query(
      `SELECT id
         FROM public.rpa_tasks
        WHERE schedule_uuid = $1
          AND deleted_at IS NULL
          AND id <> $2
        LIMIT 1`,
      [input.scheduleUuid, input.taskId]
    );
    if (conflicts[0]) throw new Error('该 scheduleUuid 已绑定其他有效任务');

    const { rows: openHistory } = await client.query(
      `SELECT history.id,
              history.schedule_uuid,
              history.bound_at,
              history.bound_at IS NOT DISTINCT FROM task.schedule_bound_at AS matches_task_bound_at
         FROM public.rpa_task_binding_history history
         JOIN public.rpa_tasks task ON task.id = history.rpa_task_id
        WHERE history.rpa_task_id = $1 AND history.unbound_at IS NULL
        ORDER BY history.id
        FOR UPDATE`,
      [input.taskId]
    );
    if (openHistory.length > 1) throw new Error('任务存在多条活动绑定历史，请先修复数据');
    if (openHistory[0] && String(openHistory[0].schedule_uuid) !== input.scheduleUuid) {
      throw new Error('任务的活动绑定历史与目标 scheduleUuid 不一致');
    }
    if (
      openHistory[0]
      && current.schedule_bound_at
      && openHistory[0].matches_task_bound_at === false
    ) {
      throw new Error('任务的 schedule_bound_at 与活动绑定历史不一致');
    }

    const boundAt = current.schedule_bound_at
      || (openHistory[0] && openHistory[0].bound_at)
      || input.boundAt
      || now();
    const changed = current.owner_user_id == null
      || current.schedule_uuid == null
      || current.schedule_bound_at == null;

    let task = current;
    if (changed) {
      const { rows } = await client.query(
        `UPDATE public.rpa_tasks
            SET owner_user_id = $2,
                schedule_uuid = $3,
                schedule_bound_at = $4,
                last_synced_at = NULL,
                sync_error = NULL,
                version = version + 1
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, owner_user_id, schedule_uuid, schedule_bound_at, version`,
        [input.taskId, input.ownerUserId, input.scheduleUuid, boundAt]
      );
      task = rows[0];
    }

    let historyInserted = false;
    if (!openHistory[0]) {
      await client.query(
        `INSERT INTO public.rpa_task_binding_history (
           rpa_task_id, schedule_uuid, bound_at, actor_user_id
         )
         SELECT id, schedule_uuid, schedule_bound_at, $2
           FROM public.rpa_tasks
          WHERE id = $1`,
        [input.taskId, input.actorUserId]
      );
      historyInserted = true;
    }

    if (changed || historyInserted) {
      await client.query(
        `INSERT INTO public.rpa_task_audit_log (
           task_id, actor_user_id, action, old_value, new_value
         ) VALUES ($1, $2, 'import', $3::jsonb, $4::jsonb)`,
        [
          input.taskId,
          input.actorUserId,
          JSON.stringify({
            owner_user_id: current.owner_user_id == null ? null : String(current.owner_user_id),
            schedule_uuid: current.schedule_uuid || null,
            schedule_bound_at: current.schedule_bound_at || null,
          }),
          JSON.stringify({
            owner_user_id: input.ownerUserId,
            schedule_uuid: input.scheduleUuid,
            schedule_bound_at: new Date(boundAt).toISOString(),
          }),
        ]
      );
    }

    return {
      taskId: String(task.id),
      ownerUserId: String(task.owner_user_id),
      scheduleUuid: task.schedule_uuid,
      scheduleBoundAt: new Date(task.schedule_bound_at).toISOString(),
      version: Number(task.version),
      changed,
      historyInserted,
    };
  });
}

async function main() {
  const input = parseArguments();
  const config = getConfig({
    requireSession: false,
    requireYingdao: false,
    validateApplication: false,
  });
  const pool = createPool(config);
  try {
    await assertLatestSchema(pool);
    const result = await backfillLegacyTask(pool, input);
    console.log(
      `历史任务补齐完成：task=${result.taskId}, owner=${result.ownerUserId}, schedule=${result.scheduleUuid}, bound_at=${result.scheduleBoundAt}`
    );
    return result;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`历史任务补齐失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, backfillLegacyTask, main };
