// 数据服务层 - 任务数据管理（对接后端 API）
import { BOT_PALETTE } from '../theme.js'

// 用于跨天对齐的虚拟日期（与 Streamlit DUMMY_DATE 保持一致）
export const DUMMY_DATE = '2025-01-01'

// 后端端口由 .env 的 PORT 注入（见 vite.config.js 的 define）
const API_PORT = import.meta.env.VITE_API_PORT || '3002'

// 动态获取 API 地址
//   开发模式：Vite dev server 与 Express 后端不同端口，需拼接完整地址
//   生产模式（Docker / Vite build）：前后端同源，用相对路径即可
function getApiBase() {
  if (import.meta.env.PROD) {
    return '/api'
  }
  return 'http://' + window.location.hostname + ':' + API_PORT + '/api'
}

// 当前任务数据 (内存缓存)
let tasksData = []

// 已分配的机器人颜色缓存（按名字稳定分配）
const botColorCache = new Map()

// 获取机器人颜色（按出现顺序从 AntD 调色板取色）
export function getBotColor(botName) {
  if (botColorCache.has(botName)) {
    return botColorCache.get(botName)
  }
  const bots = getAllBots()
  const index = bots.indexOf(botName)
  const safeIndex = index >= 0 ? index : botColorCache.size
  const color = BOT_PALETTE[safeIndex % BOT_PALETTE.length]
  botColorCache.set(botName, color)
  return color
}

// 解析时间字符串为分钟数
function timeToMinutes(timeStr) {
  if (!timeStr) return 0
  const parts = timeStr.split(':').map(Number)
  return parts[0] * 60 + (parts[1] || 0)
}

// 格式化持续时间（自动处理跨天）
export function formatDuration(startTime, finishTime) {
  const startMinutes = timeToMinutes(startTime)
  let endMinutes = timeToMinutes(finishTime)
  // 跨天：finish < start 视为次日
  if (endMinutes < startMinutes) {
    endMinutes += 24 * 60
  }
  const duration = endMinutes - startMinutes
  if (duration >= 60) {
    const hours = Math.floor(duration / 60)
    const mins = duration % 60
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }
  return `${duration}m`
}

// 判断是否为跨天任务
export function isCrossDay(startTime, finishTime) {
  return timeToMinutes(finishTime) < timeToMinutes(startTime)
}

// 将 "HH:MM:SS" 时间字符串结合 DUMMY_DATE 转为 Date 对象（自动处理跨天）
export function parseTimeToDate(startTime, finishTime) {
  const start = new Date(`${DUMMY_DATE}T${normalizeTime(startTime)}`)
  let end = new Date(`${DUMMY_DATE}T${normalizeTime(finishTime)}`)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000)
  }
  return { start, end }
}

// 标准化时间字符串为 HH:MM:SS
function normalizeTime(t) {
  if (!t) return '00:00:00'
  const segments = t.split(':')
  while (segments.length < 3) segments.push('00')
  return segments
    .slice(0, 3)
    .map(s => String(s).padStart(2, '0'))
    .join(':')
}

// ============== API 调用 ==============

export async function loadTasksFromServer() {
  try {
    const response = await fetch(`${getApiBase()}/tasks`)
    if (!response.ok) throw new Error('加载失败')
    tasksData = await response.json()
    botColorCache.clear()
    // 从服务器载入的就是磁盘上的「已保存」真相，清掉未保存标记。
    // 这样「刷新」可丢弃本地拖拽/编辑的待保存改动并复位「待保存」徽标。
    markAsSaved()
    return tasksData
  } catch (error) {
    console.error('从服务器加载数据失败:', error)
    const defaultData = await import('../data/tasks.json')
    tasksData = defaultData.default || []
    botColorCache.clear()
    markAsSaved()
    return tasksData
  }
}

export async function saveTasksToServer() {
  const response = await fetch(`${getApiBase()}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tasksData),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.message || '保存失败')
  }
  return await response.json()
}

export async function importToServer(content, format) {
  const response = await fetch(`${getApiBase()}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, format }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.message || '导入失败')
  }
  const result = await response.json()
  await loadTasksFromServer()
  return result
}

export function exportFromServer(format) {
  const url = `${getApiBase()}/export/${format}`
  const link = document.createElement('a')
  link.href = url
  link.download = `tasks_${new Date().toISOString().slice(0, 10)}.${format}`
  link.click()
}

// ============== 本地数据操作 ==============

export function getAllTasks() {
  return tasksData.map(task => ({
    ...task,
    duration: formatDuration(task.start, task.finish),
    color: getBotColor(task.bot),
    crossDay: isCrossDay(task.start, task.finish),
  }))
}

export function getAllBots() {
  const bots = [...new Set(tasksData.map(t => t.bot))]
  return bots.sort()
}

// 筛选任务（清空 selectedBots 视为显示全部，对齐 Streamlit）
export function filterTasks(
  tasks,
  { searchTerm = '', selectedBots = [], sortBy = 'bot' } = {}
) {
  let filtered = [...tasks]

  if (searchTerm.trim()) {
    const term = searchTerm.toLowerCase()
    filtered = filtered.filter(t => t.task.toLowerCase().includes(term))
  }

  if (selectedBots && selectedBots.length > 0) {
    filtered = filtered.filter(t => selectedBots.includes(t.bot))
  }

  if (sortBy === 'time') {
    filtered.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start))
  } else {
    filtered.sort((a, b) => {
      const botCompare = a.bot.localeCompare(b.bot)
      if (botCompare !== 0) return botCompare
      return timeToMinutes(a.start) - timeToMinutes(b.start)
    })
  }

  return filtered
}

export function addTask(task) {
  const newId =
    tasksData.length > 0 ? Math.max(...tasksData.map(t => t.id)) + 1 : 1
  const newTask = {
    id: newId,
    task: task.task,
    start: normalizeTime(task.start),
    finish: normalizeTime(task.finish),
    bot: task.bot,
  }
  tasksData.push(newTask)
  return newTask
}

export function updateTask(id, updates) {
  const index = tasksData.findIndex(t => t.id === id)
  if (index !== -1) {
    const patch = { ...updates }
    if (patch.start) patch.start = normalizeTime(patch.start)
    if (patch.finish) patch.finish = normalizeTime(patch.finish)
    tasksData[index] = { ...tasksData[index], ...patch }
    return tasksData[index]
  }
  return null
}

export function deleteTask(id) {
  const index = tasksData.findIndex(t => t.id === id)
  if (index !== -1) {
    tasksData.splice(index, 1)
    return true
  }
  return false
}

// 获取时间范围（用于 GanttChart 默认视图）
export function getTimeRange(tasks) {
  if (tasks.length === 0) {
    return { start: '08:00', end: '18:00' }
  }
  let minMinutes = Infinity
  let maxMinutes = -Infinity
  tasks.forEach(task => {
    const startMins = timeToMinutes(task.start)
    let endMins = timeToMinutes(task.finish)
    if (endMins < startMins) endMins += 24 * 60
    minMinutes = Math.min(minMinutes, startMins)
    maxMinutes = Math.max(maxMinutes, endMins)
  })
  minMinutes = Math.max(0, minMinutes - 15)
  maxMinutes = Math.min(48 * 60, maxMinutes + 15)
  const formatTime = mins => {
    const h = Math.floor(mins / 60) % 24
    const m = mins % 60
    return `${h.toString().padStart(2, '0')}:${m
      .toString()
      .padStart(2, '0')}`
  }
  return { start: formatTime(minMinutes), end: formatTime(maxMinutes) }
}

// 未保存标记
let hasUnsavedChanges = false
export function markAsChanged() {
  hasUnsavedChanges = true
}
export function markAsSaved() {
  hasUnsavedChanges = false
}
export function getHasUnsavedChanges() {
  return hasUnsavedChanges
}
