<template>
  <n-modal
    :show="show"
    preset="card"
    class="responsive-modal execution-history-modal"
    :title="`${task?.task || '任务'} · 执行记录`"
    @update:show="handleShowUpdate"
  >
    <n-spin :show="loading">
      <n-empty v-if="!loading && !executions.length" description="最近 30 天没有执行记录" />
      <div v-else class="execution-list">
        <article v-for="execution in executions" :key="executionKey(execution)" class="execution-card">
          <div class="execution-card-head">
            <div>
              <n-tag :type="statusType(execution.normalized_status || execution.status_name || execution.status)" :bordered="false">
                {{ execution.normalized_status || execution.status_name || execution.status || '未知状态' }}
              </n-tag>
              <time>{{ formatDateTime(execution.trigger_time) }}</time>
            </div>
            <n-button size="small" :loading="jobLoading[execution.task_uuid]" @click="loadJobs(execution)">
              {{ jobs[execution.task_uuid] ? '刷新应用明细' : '应用明细与日志' }}
            </n-button>
          </div>
          <p v-if="execution.error_remark" class="execution-error">{{ execution.error_remark }}</p>
          <code>{{ execution.task_uuid }}</code>

          <div v-if="jobs[execution.task_uuid]" class="job-list">
            <n-empty v-if="!jobs[execution.task_uuid].length" description="没有应用执行明细" size="small" />
            <section v-for="job in jobs[execution.task_uuid]" :key="job.job_uuid || job.jobUuid" class="job-card">
              <div class="job-card-head">
                <span>
                  <strong>{{ job.robot_name || job.robotName || job.robot_client_name || job.robotClientName || '影刀应用' }}</strong>
                  <small>{{ job.status_name || job.statusName || job.status || '' }}</small>
                </span>
                <n-button
                  v-if="job.job_uuid || job.jobUuid"
                  size="tiny"
                  :loading="logLoading[job.job_uuid || job.jobUuid]"
                  @click="loadLogs(job)"
                >
                  运行日志
                </n-button>
              </div>
              <p v-if="job.remark">{{ job.remark }}</p>
              <pre v-if="logs[job.job_uuid || job.jobUuid]">{{ logs[job.job_uuid || job.jobUuid] }}</pre>
              <small v-if="logCache[job.job_uuid || job.jobUuid]?.stale" class="execution-error">
                日志接口暂不可用，当前显示 {{ logCache[job.job_uuid || job.jobUuid].cache_age_seconds }} 秒前的缓存。
              </small>
              <small v-else-if="logCache[job.job_uuid || job.jobUuid]?.cached">
                日志来自 {{ logCache[job.job_uuid || job.jobUuid].cache_age_seconds }} 秒前的有效缓存。
              </small>
              <div v-if="logPagination[job.job_uuid || job.jobUuid]?.has_more" class="schedule-pagination">
                <n-button
                  size="tiny"
                  :loading="logLoading[job.job_uuid || job.jobUuid]"
                  @click="loadLogs(job, true)"
                >加载更多日志</n-button>
              </div>
            </section>
          </div>
        </article>
        <div v-if="pagination.has_more" class="schedule-pagination">
          <n-button :loading="loadingMore" @click="loadExecutions({ append: true })">加载更多执行记录</n-button>
        </div>
      </div>
    </n-spin>
  </n-modal>
</template>

<script setup>
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import { NButton, NEmpty, NModal, NSpin, NTag, useMessage } from 'naive-ui'
import { formatDateTime, statusType } from '../services/dataService.js'
import { getTaskExecutions } from '../services/taskService.js'
import { getExecutionJobs, getJobLogs } from '../services/yingdaoService.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  task: { type: Object, default: null },
})
const emit = defineEmits(['update:show'])

const message = useMessage()
const executionPageSize = 20
const logPageSize = 50
const loading = ref(false)
const loadingMore = ref(false)
const executions = ref([])
const pagination = reactive({ limit: executionPageSize, offset: 0, total: null, has_more: false })
const jobs = reactive({})
const logs = reactive({})
const logEntries = reactive({})
const logLastPage = reactive({})
const logPagination = reactive({})
const logCache = reactive({})
const jobLoading = reactive({})
const logLoading = reactive({})
let contextId = 0
let executionRequestId = 0
let nextExecutionOffset = 0
const jobRequestIds = new Map()
const logRequestIds = new Map()

function clearRecord(record) {
  for (const key of Object.keys(record)) delete record[key]
}

function clearDialogState() {
  executions.value = []
  Object.assign(pagination, { limit: executionPageSize, offset: 0, total: null, has_more: false })
  nextExecutionOffset = 0
  for (const record of [jobs, logs, logEntries, logLastPage, logPagination, logCache, jobLoading, logLoading]) clearRecord(record)
}

function invalidateRequests({ clear = false } = {}) {
  contextId += 1
  executionRequestId += 1
  jobRequestIds.clear()
  logRequestIds.clear()
  loading.value = false
  loadingMore.value = false
  clearRecord(jobLoading)
  clearRecord(logLoading)
  if (clear) clearDialogState()
}

function contextMatches(requestContext, taskId) {
  return requestContext === contextId
    && props.show
    && String(props.task?.id || '') === taskId
}

function executionKey(execution) {
  return execution.task_uuid
    || [execution.trigger_time, execution.updated_time, execution.normalized_status, execution.status].join(':')
}

watch(() => [props.show, props.task?.id], ([visible, taskId]) => {
  invalidateRequests({ clear: true })
  if (visible && taskId) loadExecutions()
}, { immediate: true })

async function loadExecutions({ append = false } = {}) {
  const taskId = String(props.task?.id || '')
  if (!props.show || !taskId || (append && !pagination.has_more)) return
  const requestContext = contextId
  const requestId = ++executionRequestId
  const offset = append ? nextExecutionOffset : 0
  if (append) loadingMore.value = true
  else loading.value = true
  try {
    const result = await getTaskExecutions(taskId, { limit: executionPageSize, offset })
    if (!contextMatches(requestContext, taskId) || requestId !== executionRequestId) return
    const rows = result.executions || []
    const existingKeys = new Set(executions.value.map(executionKey))
    const addedRows = append ? rows.filter(row => !existingKeys.has(executionKey(row))) : rows
    executions.value = append ? [...executions.value, ...addedRows] : rows
    nextExecutionOffset = Number(result.pagination?.offset || offset) + rows.length
    Object.assign(pagination, result.pagination || {}, {
      has_more: Boolean(result.pagination?.has_more && (!append || addedRows.length > 0)),
    })
  } catch (error) {
    if (contextMatches(requestContext, taskId) && requestId === executionRequestId) {
      message.error(`执行记录加载失败：${error.message}`)
    }
  } finally {
    if (contextMatches(requestContext, taskId) && requestId === executionRequestId) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

async function loadJobs(execution) {
  const uuid = execution.task_uuid
  if (!uuid) return
  const taskId = String(props.task?.id || '')
  const requestContext = contextId
  const requestId = (jobRequestIds.get(uuid) || 0) + 1
  jobRequestIds.set(uuid, requestId)
  jobLoading[uuid] = true
  try {
    const rows = await getExecutionJobs(uuid)
    if (!contextMatches(requestContext, taskId) || jobRequestIds.get(uuid) !== requestId) return
    jobs[uuid] = rows
  } catch (error) {
    if (contextMatches(requestContext, taskId) && jobRequestIds.get(uuid) === requestId) {
      message.error(`应用明细加载失败：${error.message}`)
    }
  } finally {
    if (contextMatches(requestContext, taskId) && jobRequestIds.get(uuid) === requestId) jobLoading[uuid] = false
  }
}

function renderLogs(items) {
  if (!items.length) return '本次运行没有日志。'
  return items.map(item => typeof item === 'string'
    ? item
    : `${item.time || item.timestamp || ''} [${item.level || ''}] ${item.text || item.message || ''}`.trim()
  ).join('\n')
}

async function loadLogs(job, append = false) {
  const uuid = job.job_uuid || job.jobUuid
  if (!uuid) return
  const taskId = String(props.task?.id || '')
  const requestContext = contextId
  const requestId = (logRequestIds.get(uuid) || 0) + 1
  logRequestIds.set(uuid, requestId)
  const currentPage = Number(logPagination[uuid]?.page || 0)
  const page = append ? currentPage + 1 : 1
  logLoading[uuid] = true
  try {
    const result = await getJobLogs(uuid, { page, size: logPageSize })
    if (!contextMatches(requestContext, taskId) || logRequestIds.get(uuid) !== requestId) return
    const previous = logEntries[uuid] || []
    const replayedPage = append && JSON.stringify(result.logs) === JSON.stringify(logLastPage[uuid] || [])
    const entries = replayedPage ? previous : (append ? [...previous, ...result.logs] : result.logs)
    logEntries[uuid] = entries
    logLastPage[uuid] = result.logs
    logs[uuid] = renderLogs(entries)
    logPagination[uuid] = {
      ...result.pagination,
      has_more: Boolean(result.pagination?.has_more && !replayedPage),
    }
    logCache[uuid] = {
      cached: result.cached,
      stale: result.stale,
      cache_age_seconds: result.cache_age_seconds,
    }
  } catch (error) {
    if (contextMatches(requestContext, taskId) && logRequestIds.get(uuid) === requestId) {
      message.error(`运行日志加载失败：${error.message}`)
    }
  } finally {
    if (contextMatches(requestContext, taskId) && logRequestIds.get(uuid) === requestId) logLoading[uuid] = false
  }
}

function handleShowUpdate(value) {
  if (!value) invalidateRequests({ clear: true })
  emit('update:show', value)
}

onBeforeUnmount(() => invalidateRequests({ clear: true }))
</script>
