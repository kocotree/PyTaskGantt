const express = require('express');
const { z } = require('zod');
const asyncHandler = require('../middleware/asyncHandler.cjs');
const { ValidationError } = require('../errors.cjs');
const { presentUser } = require('../presenters.cjs');

const logPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000),
  size: z.coerce.number().int().min(1).max(100),
});

function parseLogPagination(query = {}) {
  const parsed = logPaginationSchema.safeParse({
    page: query.page ?? 1,
    size: query.size ?? 100,
  });
  if (!parsed.success) throw new ValidationError('日志分页参数不正确', parsed.error.flatten());
  return parsed.data;
}

function createYingdaoRouter({ scheduleDirectory, executionDetails }) {
  const router = express.Router();

  router.get('/yingdao/schedules', asyncHandler(async (req, res) => {
    const query = req.query.query || '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
    const includeBound = ['1', 'true', 'yes'].includes(String(req.query.include_bound || '').toLowerCase())
      || Boolean(String(query).trim());
    const result = await scheduleDirectory.list({
      query,
      page,
      size,
      include_bound: includeBound,
      current_user_id: req.userId,
    });
    const pageInfo = result.page || {};
    const cache = result.cache || {};
    res.json({
      schedules: (result.schedules || []).map(schedule => ({
        ...schedule,
        bound_owner: schedule.bound_owner && typeof schedule.bound_owner === 'object'
          ? presentUser(schedule.bound_owner)
          : schedule.bound_owner || null,
      })),
      page,
      size,
      total: Number(pageInfo.total || pageInfo.totalElements || pageInfo.records || result.schedules.length),
      pages: Number(pageInfo.pages || pageInfo.totalPages || 1),
      cached: Boolean(cache.hit),
      stale: Boolean(cache.stale),
      cache_age_seconds: Math.round(Number(cache.ageMs || 0) / 1000),
      fetched_at: cache.fetchedAt || null,
    });
  }));

  router.get('/executions/:taskUuid/jobs', asyncHandler(async (req, res) => {
    res.json({ jobs: await executionDetails.getJobs(String(req.params.taskUuid)) });
  }));

  const getJobLogs = asyncHandler(async (req, res) => {
    const jobUuid = String(req.params.jobUuid || '').trim();
    if (!jobUuid || jobUuid.length > 200) throw new ValidationError('jobUuid 不正确');
    const pagination = parseLogPagination(req.query);
    const result = await executionDetails.getLogs(jobUuid, {
      ...pagination,
      currentUserId: req.userId,
    });
    if (Array.isArray(result)) {
      return res.json({
        logs: result,
        pagination: {
          ...pagination,
          total: result.length,
          has_more: false,
        },
        cached: false,
      });
    }
    const cache = result.cache || {};
    const metadata = result.pagination || {
      ...pagination,
      total: (result.logs || []).length,
      hasMore: false,
    };
    res.json({
      logs: result.logs || [],
      pagination: {
        page: metadata.page,
        size: metadata.size,
        total: metadata.total,
        has_more: Boolean(metadata.hasMore ?? metadata.has_more),
      },
      cached: Boolean(cache.hit),
      stale: Boolean(cache.stale),
      cache_age_seconds: Math.round(Number(cache.ageMs || 0) / 1000),
      fetched_at: cache.fetchedAt || null,
    });
  });

  router.get('/yingdao/jobs/:jobUuid/logs', getJobLogs);
  // 兼容旧前端路径；新调用应使用 /api/yingdao/jobs/:jobUuid/logs。
  router.get('/jobs/:jobUuid/logs', getJobLogs);

  return router;
}

module.exports = { createYingdaoRouter, parseLogPagination };
