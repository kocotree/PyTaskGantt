import { BOT_PALETTE } from '../theme.js'

export const DUMMY_DATE = '2025-01-01'

function timeToMinutes(timeStr) {
  if (!timeStr) return 0
  const [hour = 0, minute = 0] = String(timeStr).split(':').map(Number)
  return hour * 60 + minute
}

export function normalizeTime(value) {
  if (!value) return '00:00:00'
  const segments = String(value).split(':')
  while (segments.length < 3) segments.push('00')
  return segments.slice(0, 3).map(segment => String(segment).padStart(2, '0')).join(':')
}

export function formatDuration(startTime, finishTime) {
  const startMinutes = timeToMinutes(startTime)
  let endMinutes = timeToMinutes(finishTime)
  if (endMinutes < startMinutes) endMinutes += 24 * 60
  const duration = endMinutes - startMinutes
  if (duration >= 60) {
    const hours = Math.floor(duration / 60)
    const mins = duration % 60
    return mins ? `${hours}h ${mins}m` : `${hours}h`
  }
  return `${duration}m`
}

export function isCrossDay(startTime, finishTime) {
  return timeToMinutes(finishTime) < timeToMinutes(startTime)
}

export function parseTimeToDate(startTime, finishTime) {
  const start = new Date(`${DUMMY_DATE}T${normalizeTime(startTime)}`)
  let end = new Date(`${DUMMY_DATE}T${normalizeTime(finishTime)}`)
  if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
  return { start, end }
}

function hashText(value) {
  let hash = 0
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.codePointAt(0)) | 0
  return Math.abs(hash)
}

export function getBotColor(botName) {
  return BOT_PALETTE[hashText(botName) % BOT_PALETTE.length]
}

export function decorateTask(task) {
  return {
    ...task,
    duration: formatDuration(task.start, task.finish),
    color: getBotColor(task.bot),
    crossDay: isCrossDay(task.start, task.finish),
  }
}

export function filterTasks(tasks, {
  searchTerm = '',
  selectedBots = [],
  selectedOwners = [],
  sortBy = 'bot',
} = {}) {
  let rows = tasks.map(decorateTask)
  const term = searchTerm.trim().toLocaleLowerCase('zh-CN')
  if (term) rows = rows.filter(task => task.task.toLocaleLowerCase('zh-CN').includes(term))
  if (selectedBots.length) rows = rows.filter(task => selectedBots.includes(task.bot))
  if (selectedOwners.length) {
    rows = rows.filter(task => selectedOwners.includes(task.owner?.id || 'legacy'))
  }
  rows.sort((left, right) => {
    if (sortBy === 'time') return timeToMinutes(left.start) - timeToMinutes(right.start)
    if (sortBy === 'owner') {
      const owner = (left.owner?.display_name || '').localeCompare(right.owner?.display_name || '', 'zh-CN')
      if (owner) return owner
    }
    const bot = left.bot.localeCompare(right.bot, 'zh-CN')
    return bot || timeToMinutes(left.start) - timeToMinutes(right.start)
  })
  return rows
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char])
}

export function statusType(status) {
  if (status === '运行成功') return 'success'
  if (['运行失败', '等待超时', '运行超时'].includes(status)) return 'error'
  if (['等待中', '运行中'].includes(status)) return 'info'
  if (status === '已停止') return 'warning'
  return 'default'
}

export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

export function summarizeSyncCutoff(tasks = []) {
  const boundTasks = (Array.isArray(tasks) ? tasks : []).filter(task => task?.schedule_uuid)
  const timestamps = boundTasks
    .map(task => Date.parse(task.last_synced_at || ''))
    .filter(Number.isFinite)
  return {
    boundCount: boundTasks.length,
    timestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    incomplete: timestamps.length < boundTasks.length,
  }
}
