const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { presentTask } = require('../presenters.cjs');
const { parseBigintId, parseTaskId } = require('./tasks.cjs');

const recoverySchema = z.object({
  version: z.coerce.number().int().positive(),
  owner_user_id: z.union([z.string().min(1), z.number().positive()]),
  schedule_uuid: z.string().trim().min(1).max(200),
}).strict();

function createAdminRouter({ taskActionService }) {
  const router = express.Router();

  router.post('/admin/tasks/:id/recover', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const parsed = recoverySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('请求数据不正确', parsed.error.flatten());
    const input = {
      ...parsed.data,
      owner_user_id: parseBigintId(parsed.data.owner_user_id, '目标用户 ID'),
    };
    const result = await taskActionService.recover(req.actor, taskId, input);
    res.json({ ...result, task: presentTask(result.task) });
  }));

  return router;
}

module.exports = { createAdminRouter, recoverySchema };
