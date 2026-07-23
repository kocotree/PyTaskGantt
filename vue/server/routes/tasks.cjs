const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { presentUser, presentTask, presentExecution } = require('../presenters.cjs');

const versionSchema = z.coerce.number().int().positive();
const MAX_BIGINT = 9223372036854775807n;
const executionPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200),
  offset: z.coerce.number().int().min(0).max(1_000_000_000),
});

function parseBody(schema, body) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ValidationError('请求数据不正确', parsed.error.flatten());
  return parsed.data;
}

function parseBigintId(value, label = 'ID') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} 必须使用精确的正整数字符串`);
  }
  const id = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(id)) {
    throw new ValidationError(`${label} 必须是正整数`);
  }
  try {
    if (BigInt(id) > MAX_BIGINT) throw new Error('out of range');
  } catch (_error) {
    throw new ValidationError(`${label} 超出 BIGINT 范围`);
  }
  return id;
}

function parseTaskId(value) {
  return parseBigintId(value, '任务 ID');
}

function parseExecutionPagination(query = {}) {
  return parseBody(executionPaginationSchema, {
    limit: query.limit ?? 50,
    offset: query.offset ?? 0,
  });
}

function createTasksRouter({ usersRepository, tasksRepository, taskMutationService, taskActionService, syncCoordinator }) {
  const router = express.Router();

  router.get('/users', asyncHandler(async (_req, res) => {
    res.json({ users: (await usersRepository.listActive()).map(presentUser) });
  }));

  router.get('/tasks', asyncHandler(async (req, res) => {
    const tasks = await tasksRepository.listAll(req.userId, {
      currentUserIsAdmin: req.actor.isAdmin,
    });
    res.json({ tasks: tasks.map(presentTask), server_time: new Date().toISOString() });
  }));

  router.get('/my/tasks', asyncHandler(async (req, res) => {
    const filters = {
      query: req.query.query || '',
      tags: Array.isArray(req.query.tags)
        ? req.query.tags
        : String(req.query.tags || '').split(',').map(value => value.trim()).filter(Boolean),
      normalizedStatus: req.query.normalized_status || '',
      sort: req.query.sort || 'updated',
    };
    const tasks = await tasksRepository.listMine(req.userId, filters);
    res.json({ tasks: tasks.map(presentTask), server_time: new Date().toISOString() });
  }));

  router.post('/tasks/batch', asyncHandler(async (req, res) => {
    const result = await taskMutationService.applyBatch(req.actor, req.body);
    res.json({ ...result, tasks: (result.tasks || []).map(presentTask) });
  }));

  router.delete('/tasks/:id', asyncHandler(async (req, res) => {
    const id = parseTaskId(req.params.id);
    const { version } = parseBody(z.object({ version: versionSchema }), req.body || {});
    const result = await taskMutationService.applyBatch(req.actor, {
      mutations: [{ type: 'delete', id, version }],
    });
    res.json({ ...result, tasks: (result.tasks || []).map(presentTask) });
  }));

  router.post('/tasks/:id/rebind', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const input = parseBody(z.object({
      schedule_uuid: z.string().trim().min(1).max(200),
      version: versionSchema,
    }), req.body);
    const result = await taskActionService.rebind(req.actor, taskId, input);
    res.json({ ...result, task: presentTask(result.task) });
  }));

  router.post('/tasks/:id/transfer', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const input = parseBody(z.object({
      target_user_id: z.union([z.string().min(1), z.number().positive()]),
      version: versionSchema,
    }), req.body);
    input.target_user_id = parseBigintId(input.target_user_id, '接收用户 ID');
    const result = await taskActionService.transfer(req.actor, taskId, input);
    res.json({ ...result, task: presentTask(result.task) });
  }));

  router.post('/tasks/:id/run', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    res.status(202).json(await taskActionService.runNow(req.actor, taskId));
  }));

  router.post('/tasks/:id/sync', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    res.status(202).json(await syncCoordinator.syncTask(req.actor, taskId));
  }));

  router.post('/my/tasks/sync', asyncHandler(async (req, res) => {
    res.status(202).json(await syncCoordinator.syncUser(req.userId));
  }));

  router.get('/tasks/:id/executions', asyncHandler(async (req, res) => {
    const taskId = parseTaskId(req.params.id);
    const pagination = parseExecutionPagination(req.query);
    const result = typeof tasksRepository.listExecutionsPage === 'function'
      ? await tasksRepository.listExecutionsPage(taskId, pagination)
      : {
          executions: await tasksRepository.listExecutions(taskId, pagination),
          pagination: null,
        };
    const executions = result.executions || [];
    const metadata = result.pagination || {
      ...pagination,
      total: pagination.offset + executions.length,
      hasMore: false,
    };
    res.json({
      executions: executions.map(presentExecution),
      pagination: {
        limit: metadata.limit,
        offset: metadata.offset,
        total: metadata.total,
        has_more: Boolean(metadata.hasMore ?? metadata.has_more),
      },
    });
  }));

  return router;
}

module.exports = { createTasksRouter, parseBigintId, parseTaskId, parseExecutionPagination };
