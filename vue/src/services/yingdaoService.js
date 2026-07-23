import { apiRequest, toQuery } from './apiClient.js'

function optionalNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

export function normalizeSchedulesPayload(payload, params = {}) {
  const schedules = Array.isArray(payload) ? payload : payload?.schedules || []
  const pageInfo = payload?.page && typeof payload.page === 'object' ? payload.page : {}
  const cache = payload?.cache || {}
  return {
    schedules: schedules.map(item => ({
      ...item,
      schedule_uuid: item.schedule_uuid || item.scheduleUuid || '',
      schedule_name: item.schedule_name || item.scheduleName || item.name || '',
      bound: Boolean(item.bound),
    })),
    page: Number(pageInfo.page || payload?.page || params.page || 1),
    size: Number(pageInfo.size || payload?.size || params.size || 20),
    total: Number(pageInfo.total || pageInfo.totalCount || payload?.total || (pageInfo.pages ? pageInfo.pages * (params.size || 20) : schedules.length)),
    cached: Boolean(payload?.cached ?? cache.hit ?? payload?.stale ?? cache.stale),
    stale: Boolean(payload?.stale ?? cache.stale),
    cache_age_seconds: Number(payload?.cache_age_seconds || Math.round(Number(cache.ageMs || 0) / 1000)),
    fetched_at: payload?.fetched_at || cache.fetchedAt || null,
  }
}

export async function getSchedules(params = {}) {
  const payload = await apiRequest(`/yingdao/schedules${toQuery(params)}`)
  return normalizeSchedulesPayload(payload, params)
}

export async function getExecutionJobs(taskUuid) {
  const payload = await apiRequest(`/executions/${encodeURIComponent(taskUuid)}/jobs`)
  return Array.isArray(payload) ? payload : payload?.jobs || []
}

export function normalizeJobLogsPayload(payload, params = {}) {
  const logs = Array.isArray(payload) ? payload : payload?.logs || []
  const pageInfo = payload?.pagination || (payload?.page && typeof payload.page === 'object' ? payload.page : {})
  const page = Math.max(1, optionalNumber(pageInfo.page, params.page) || 1)
  const size = Math.max(1, optionalNumber(pageInfo.size, pageInfo.limit, params.size, params.limit) || 50)
  const total = optionalNumber(pageInfo.total, payload?.total)
  const explicitHasMore = pageInfo.has_more ?? pageInfo.hasMore ?? payload?.has_more ?? payload?.hasMore
  const hasMore = explicitHasMore == null
    ? (total == null ? logs.length >= size && logs.length > 0 : page * size < total)
    : Boolean(explicitHasMore)
  return {
    logs,
    pagination: { page, size, total, has_more: hasMore },
    cached: Boolean(payload?.cached),
    stale: Boolean(payload?.stale),
    cache_age_seconds: Number(payload?.cache_age_seconds || 0),
  }
}

export async function getJobLogs(jobUuid, params = {}) {
  const payload = await apiRequest(`/yingdao/jobs/${encodeURIComponent(jobUuid)}/logs${toQuery(params)}`)
  return normalizeJobLogsPayload(payload, params)
}
