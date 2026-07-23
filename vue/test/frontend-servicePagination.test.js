import { describe, expect, it } from 'vitest'
import { normalizeExecutionPayload } from '../src/services/taskService.js'
import { normalizeJobLogsPayload, normalizeSchedulesPayload } from '../src/services/yingdaoService.js'

describe('frontend service pagination normalization', () => {
  it('consumes execution pagination metadata and remains compatible with legacy arrays', () => {
    expect(normalizeExecutionPayload({
      executions: [{ task_uuid: 'run-1' }],
      pagination: { limit: 20, offset: 20, total: 45, has_more: true },
    })).toEqual({
      executions: [{ task_uuid: 'run-1' }],
      pagination: { limit: 20, offset: 20, total: 45, has_more: true },
    })

    expect(normalizeExecutionPayload([{ task_uuid: 'legacy-run' }], { limit: 20, offset: 0 }).pagination)
      .toEqual({ limit: 20, offset: 0, total: null, has_more: false })
  })

  it('distinguishes a fresh cache hit from stale fallback data', () => {
    const fresh = normalizeSchedulesPayload({ schedules: [], cached: true, stale: false, cache_age_seconds: 8 })
    const stale = normalizeSchedulesPayload({ schedules: [], cached: true, stale: true, cache_age_seconds: 75 })

    expect(fresh).toMatchObject({ cached: true, stale: false, cache_age_seconds: 8 })
    expect(stale).toMatchObject({ cached: true, stale: true, cache_age_seconds: 75 })
  })

  it('consumes paginated job logs and infers legacy completion', () => {
    expect(normalizeJobLogsPayload({
      logs: ['line 2'],
      pagination: { page: 2, size: 1, total: 3, has_more: true },
      cached: true,
    })).toMatchObject({
      logs: ['line 2'],
      pagination: { page: 2, size: 1, total: 3, has_more: true },
      cached: true,
    })

    expect(normalizeJobLogsPayload(['only line'], { page: 1, size: 50 }).pagination)
      .toEqual({ page: 1, size: 50, total: null, has_more: false })
  })
})
