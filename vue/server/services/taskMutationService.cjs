const {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  databaseError,
} = require('../errors.cjs');
const { parseBatch } = require('./taskValidation.cjs');
const { loadTasksByIds } = require('./taskQueries.cjs');
const { timestampAfter } = require('../db/values.cjs');

const FIELD_TO_COLUMN = {
  task: 'task',
  start: 'start_time',
  finish: 'finish_time',
  bot: 'bot',
  tags: 'tags',
  note: 'note',
};

async function addAudit(client, { taskId, actorUserId, action, oldValue = null, newValue = null }) {
  const result = await client.query(
    `INSERT INTO rpa_task_audit_log (task_id, actor_user_id, action, old_value, new_value)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING id`,
    [taskId, actorUserId, action, JSON.stringify(oldValue), JSON.stringify(newValue)]
  );
  return result.rows && result.rows[0] ? result.rows[0].id : null;
}

function assertOwner(row, userId) {
  if (!row) throw new NotFoundError('任务不存在或已删除');
  if (row.owner_user_id == null || String(row.owner_user_id) !== String(userId)) {
    throw new AuthorizationError('只能修改自己的任务');
  }
  if (!row.schedule_uuid || !row.schedule_bound_at) {
    throw new AuthorizationError('历史未绑定任务仅可只读；请先通过运维补齐所有者与计划绑定');
  }
}

async function lockTask(client, id) {
  const { rows } = await client.query(
    `SELECT * FROM rpa_tasks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

async function validateSchedule(scheduleDirectory, scheduleUuid, context) {
  if (!scheduleDirectory || typeof scheduleDirectory.assertBindable !== 'function') {
    throw new Error('计划目录服务未配置 assertBindable');
  }
  await scheduleDirectory.assertBindable(scheduleUuid, context);
}

function createTaskMutationService({ pool, scheduleDirectory }) {
  return {
    async applyBatch(userId, body) {
      const input = parseBatch(body);
      const createSchedules = input.mutations
        .filter(item => item.type === 'create')
        .map(item => item.schedule_uuid);
      if (new Set(createSchedules).size !== createSchedules.length) {
        throw new ConflictError('SCHEDULE_ALREADY_BOUND', '同一批次不能重复绑定同一个影刀计划');
      }
      for (const scheduleUuid of createSchedules) {
        await validateSchedule(scheduleDirectory, scheduleUuid, { actorUserId: userId });
      }

      const client = await pool.connect();
      const changedIds = [];
      const idMap = {};
      let inserted = 0;
      let updated = 0;
      let deleted = 0;
      try {
        await client.query('BEGIN');
        for (const mutation of input.mutations) {
          if (mutation.type === 'create') {
            const { rows } = await client.query(
              `INSERT INTO rpa_tasks (
                 task, start_time, finish_time, bot, tags, note,
                 created_by_user_id, owner_user_id, schedule_uuid, schedule_bound_at
               ) VALUES (
                 $1, $2, $3, $4, $5::text[], $6, $7, $7, $8,
                 date_trunc('milliseconds', clock_timestamp())
               )
               RETURNING *`,
              [
                mutation.task, mutation.start, mutation.finish, mutation.bot,
                mutation.tags, mutation.note, userId, mutation.schedule_uuid,
              ]
            );
            const row = rows[0];
            await client.query(
              `INSERT INTO rpa_task_binding_history
                 (rpa_task_id, schedule_uuid, bound_at, actor_user_id)
               SELECT id, schedule_uuid, schedule_bound_at, $2
                 FROM rpa_tasks
                WHERE id = $1`,
              [row.id, userId]
            );
            await addAudit(client, {
              taskId: row.id,
              actorUserId: userId,
              action: input.audit_action || 'create',
              newValue: {
                task: row.task,
                start: row.start_time,
                finish: row.finish_time,
                bot: row.bot,
                tags: row.tags,
                note: row.note,
                schedule_uuid: row.schedule_uuid,
                owner_user_id: String(userId),
              },
            });
            const id = String(row.id);
            idMap[mutation.temp_id] = id;
            changedIds.push(id);
            inserted += 1;
            continue;
          }

          const current = await lockTask(client, mutation.id);
          assertOwner(current, userId);
          if (Number(current.version) !== mutation.version) {
            throw new ConflictError('VERSION_CONFLICT', `任务「${current.task}」已被其他操作修改`, {
              task_id: String(current.id),
              current_version: current.version,
            });
          }

          if (mutation.type === 'update') {
            const entries = Object.entries(mutation.changes);
            const values = [];
            const assignments = entries.map(([field, value], index) => {
              values.push(value);
              const cast = field === 'tags' ? '::text[]' : '';
              return `${FIELD_TO_COLUMN[field]} = $${index + 3}${cast}`;
            });
            const { rows } = await client.query(
              `UPDATE rpa_tasks
               SET ${assignments.join(', ')}, version = version + 1, updated_at = now()
               WHERE id = $1 AND version = $2 AND deleted_at IS NULL
               RETURNING *`,
              [mutation.id, mutation.version, ...values]
            );
            if (!rows[0]) throw new ConflictError('VERSION_CONFLICT');
            await addAudit(client, {
              taskId: current.id,
              actorUserId: userId,
              action: 'update',
              oldValue: Object.fromEntries(entries.map(([field]) => [field, current[FIELD_TO_COLUMN[field]]])),
              newValue: mutation.changes,
            });
            changedIds.push(String(current.id));
            updated += 1;
            continue;
          }

          const deletedAt = timestampAfter(current.schedule_bound_at);
          if (current.schedule_uuid) {
            await client.query(
              `UPDATE rpa_task_binding_history
               SET unbound_at = $2
               WHERE rpa_task_id = $1 AND unbound_at IS NULL`,
              [current.id, deletedAt]
            );
          }
          const { rows } = await client.query(
            `UPDATE rpa_tasks
             SET deleted_at = $3, schedule_uuid = NULL, schedule_bound_at = NULL,
                 version = version + 1, updated_at = $3
             WHERE id = $1 AND version = $2 AND deleted_at IS NULL
             RETURNING id`,
            [current.id, mutation.version, deletedAt]
          );
          if (!rows[0]) throw new ConflictError('VERSION_CONFLICT');
          await addAudit(client, {
            taskId: current.id,
            actorUserId: userId,
            action: 'delete',
            oldValue: { schedule_uuid: current.schedule_uuid, version: current.version },
            newValue: { deleted_at: deletedAt.toISOString() },
          });
          deleted += 1;
        }

        const tasks = await loadTasksByIds(client, changedIds, userId);
        await client.query('COMMIT');
        return {
          success: true,
          tasks,
          id_map: idMap,
          inserted,
          updated,
          deleted,
          message: `已保存：新增 ${inserted}、修改 ${updated}、删除 ${deleted}`,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw databaseError(error);
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createTaskMutationService, addAudit, assertOwner, lockTask };
