import { computed, reactive, readonly } from 'vue'
import { getMyTasks, getTasks, normalizeTask, saveTaskMutations } from '../services/taskService.js'

const CREATE_FIELDS = ['task', 'start', 'finish', 'bot', 'schedule_uuid', 'tags', 'note']
const UPDATE_FIELDS = ['task', 'start', 'finish', 'bot', 'tags', 'note']
const LIVE_FIELDS = ['normalized_status', 'last_run_at', 'last_synced_at', 'sync_error']

function cloneTask(task) {
  return { ...task, tags: [...(task.tags || [])], owner: task.owner ? { ...task.owner } : null }
}

function taskKey(id) {
  return String(id)
}

function normalizeTags(tags) {
  return [...new Set((tags || []).map(tag => String(tag).trim()).filter(Boolean))]
}

function comparable(value) {
  return Array.isArray(value) ? JSON.stringify(value) : value ?? ''
}

function makeTempId() {
  if (globalThis.crypto?.randomUUID) return `tmp:${globalThis.crypto.randomUUID()}`
  return `tmp:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function pickFields(source, fields) {
  const input = source || {}
  return Object.fromEntries(fields.filter(field => field in input).map(field => [field, input[field]]))
}

function cloneMutation(mutation) {
  if (!mutation) return null
  return JSON.parse(JSON.stringify(mutation))
}

function cleanMutation(mutation) {
  if (!mutation) return null
  const { _deleted, ...clean } = cloneMutation(mutation)
  return clean
}

function sameMutation(left, right) {
  return JSON.stringify(cleanMutation(left)) === JSON.stringify(cleanMutation(right))
}

function taskChanges(task, saved) {
  const changes = {}
  for (const field of UPDATE_FIELDS) {
    if (comparable(task[field]) !== comparable(saved[field])) changes[field] = task[field]
  }
  return changes
}

export function createTaskDraftStore(loader, saver = saveTaskMutations) {
  const state = reactive({
    tasks: [],
    savedTasks: {},
    mutations: {},
    loaded: false,
    loading: false,
    saving: false,
    error: '',
    serverTime: null,
  })
  let generation = 0
  let loadRequestId = 0
  let saveRequestId = 0
  let savePromise = null
  const activeLoads = new Set()
  const foregroundLoads = new Set()

  const visibleTasks = computed(() => state.tasks.filter(task => !state.mutations[taskKey(task.id)]?._deleted))
  const hasUnsaved = computed(() => Object.keys(state.mutations).length > 0)
  const mutationList = computed(() => Object.values(state.mutations).map(({ _deleted, ...mutation }) => mutation))

  function hydrate(tasks, serverTime = null) {
    const normalized = tasks.map(row => normalizeTask(row))
    state.tasks = normalized.map(cloneTask)
    state.savedTasks = Object.fromEntries(normalized.map(task => [taskKey(task.id), cloneTask(task)]))
    state.mutations = {}
    state.serverTime = serverTime
    state.loaded = true
    state.error = ''
  }

  function mergeServer(tasks, serverTime) {
    const serverRows = tasks.map(row => normalizeTask(row))
    const serverMap = new Map(serverRows.map(task => [taskKey(task.id), task]))
    const next = []

    for (const draft of state.tasks) {
      const key = taskKey(draft.id)
      const mutation = state.mutations[key]
      if (mutation?.type === 'create') {
        next.push(draft)
        continue
      }
      const serverTask = serverMap.get(key)
      if (!serverTask) {
        if (mutation) next.push(draft)
        else delete state.savedTasks[key]
        continue
      }
      serverMap.delete(key)
      if (mutation) {
        const merged = cloneTask(draft)
        for (const field of LIVE_FIELDS) merged[field] = serverTask[field]
        next.push(merged)
      } else {
        next.push(cloneTask(serverTask))
        state.savedTasks[key] = cloneTask(serverTask)
      }
    }
    for (const task of serverMap.values()) {
      next.push(cloneTask(task))
      state.savedTasks[taskKey(task.id)] = cloneTask(task)
    }
    const retainedKeys = new Set(next.map(task => taskKey(task.id)))
    for (const key of Object.keys(state.savedTasks)) {
      if (!retainedKeys.has(key) && !state.mutations[key]) delete state.savedTasks[key]
    }
    state.tasks = next
    state.serverTime = serverTime
    state.loaded = true
    state.error = ''
  }

  function isCurrentRequest(requestGeneration, requestId, type) {
    if (requestGeneration !== generation) return false
    return type === 'save' ? requestId === saveRequestId : requestId === loadRequestId
  }

  async function load({ preserveDraft = true, silent = false, allowDuringSave = false } = {}) {
    if (!allowDuringSave && state.saving) return visibleTasks.value
    if (silent && activeLoads.size && !allowDuringSave) return visibleTasks.value

    const requestGeneration = generation
    const requestId = ++loadRequestId
    const loadToken = { generation: requestGeneration, requestId }
    activeLoads.add(loadToken)
    if (!silent) {
      foregroundLoads.add(loadToken)
      state.loading = true
    }
    try {
      const result = await loader()
      if (!isCurrentRequest(requestGeneration, requestId, 'load')) return visibleTasks.value
      if (preserveDraft && hasUnsaved.value) mergeServer(result.tasks, result.serverTime)
      else hydrate(result.tasks, result.serverTime)
      return visibleTasks.value
    } catch (error) {
      if (!isCurrentRequest(requestGeneration, requestId, 'load')) return visibleTasks.value
      state.error = error.message || '加载失败'
      throw error
    } finally {
      activeLoads.delete(loadToken)
      foregroundLoads.delete(loadToken)
      if (requestGeneration === generation) state.loading = foregroundLoads.size > 0
    }
  }

  function addTask(input) {
    const tempId = makeTempId()
    const task = normalizeTask({
      ...input,
      id: tempId,
      version: 0,
      can_edit: true,
      tags: normalizeTags(input.tags),
      normalized_status: '待运行',
      _is_new: true,
    })
    state.tasks.push(task)
    state.mutations[tempId] = {
      type: 'create',
      temp_id: tempId,
      ...Object.fromEntries(CREATE_FIELDS.map(field => [field, cloneTask(task)[field]])),
    }
    return task
  }

  function updateTask(id, updates) {
    const key = taskKey(id)
    const index = state.tasks.findIndex(task => taskKey(task.id) === key)
    if (index < 0 || !state.tasks[index].can_edit) return null
    const allowedFields = state.tasks[index]._is_new || key.startsWith('tmp:') ? CREATE_FIELDS : UPDATE_FIELDS
    const patch = pickFields(updates, allowedFields)
    if ('tags' in patch) patch.tags = normalizeTags(patch.tags)
    state.tasks[index] = normalizeTask({ ...state.tasks[index], ...patch })
    const task = state.tasks[index]

    if (task._is_new || key.startsWith('tmp:')) {
      state.mutations[key] = {
        type: 'create',
        temp_id: key,
        ...Object.fromEntries(CREATE_FIELDS.map(field => [field, cloneTask(task)[field]])),
      }
      return task
    }

    const saved = state.savedTasks[key]
    if (!saved) return task
    const changes = taskChanges(task, saved)
    if (Object.keys(changes).length) {
      state.mutations[key] = { type: 'update', id: key, version: saved.version, changes }
    } else {
      delete state.mutations[key]
    }
    return task
  }

  function deleteTask(id) {
    const key = taskKey(id)
    const index = state.tasks.findIndex(task => taskKey(task.id) === key)
    if (index < 0 || !state.tasks[index].can_edit) return false
    if (key.startsWith('tmp:') || state.tasks[index]._is_new) {
      state.tasks.splice(index, 1)
      delete state.mutations[key]
      return true
    }
    const saved = state.savedTasks[key]
    state.mutations[key] = { type: 'delete', id: key, version: saved?.version || state.tasks[index].version, _deleted: true }
    return true
  }

  function isDirty(id) {
    return Boolean(state.mutations[taskKey(id)])
  }

  function discard() {
    if (state.saving) return false
    loadRequestId += 1
    const rows = Object.values(state.savedTasks).map(cloneTask)
    hydrate(rows, state.serverTime)
    return true
  }

  function reconcileSaveResult(submitted, result) {
    const submittedMap = new Map(submitted.map(mutation => [taskKey(mutation.temp_id || mutation.id), mutation]))
    const returned = new Map((result.tasks || []).map(task => [taskKey(task.id), normalizeTask(task)]))
    const idMap = result.id_map || {}
    const processed = new Set()
    const nextTasks = []
    const nextSavedTasks = Object.fromEntries(
      Object.entries(state.savedTasks).map(([key, task]) => [key, cloneTask(task)])
    )
    const nextMutations = {}

    for (const current of state.tasks) {
      const oldKey = taskKey(current.id)
      const submittedMutation = submittedMap.get(oldKey)
      const currentMutation = state.mutations[oldKey]
      if (!submittedMutation) {
        nextTasks.push(cloneTask(current))
        if (currentMutation) nextMutations[oldKey] = cloneMutation(currentMutation)
        continue
      }

      processed.add(oldKey)
      delete nextSavedTasks[oldKey]
      if (submittedMutation.type === 'delete') continue

      const mappedKey = taskKey(idMap[oldKey] || oldKey)
      const serverTask = returned.get(mappedKey) || normalizeTask({
        ...current,
        id: mappedKey,
        version: submittedMutation.type === 'create' ? 1 : Number(current.version || 0) + 1,
        _is_new: false,
      })
      const baseline = cloneTask({ ...serverTask, id: mappedKey, _is_new: false })
      nextSavedTasks[mappedKey] = cloneTask(baseline)

      if (sameMutation(currentMutation, submittedMutation)) {
        nextTasks.push(baseline)
        continue
      }

      if (currentMutation?.type === 'delete') {
        nextTasks.push(baseline)
        nextMutations[mappedKey] = {
          type: 'delete', id: mappedKey, version: baseline.version, _deleted: true,
        }
        continue
      }

      const draft = normalizeTask({
        ...baseline,
        ...pickFields(current, UPDATE_FIELDS),
        id: mappedKey,
        version: baseline.version,
        _is_new: false,
      })
      const changes = taskChanges(draft, baseline)
      nextTasks.push(draft)
      if (Object.keys(changes).length) {
        nextMutations[mappedKey] = { type: 'update', id: mappedKey, version: baseline.version, changes }
      }
    }

    for (const [oldKey, submittedMutation] of submittedMap) {
      if (processed.has(oldKey)) continue
      delete nextSavedTasks[oldKey]
      if (submittedMutation.type === 'delete') continue
      const mappedKey = taskKey(idMap[oldKey] || oldKey)
      const serverTask = returned.get(mappedKey)
      if (!serverTask) continue
      const baseline = cloneTask({ ...serverTask, id: mappedKey, _is_new: false })
      nextTasks.push(baseline)
      nextSavedTasks[mappedKey] = cloneTask(baseline)
      if (submittedMutation.type === 'create') {
        nextMutations[mappedKey] = {
          type: 'delete', id: mappedKey, version: baseline.version, _deleted: true,
        }
      }
    }

    state.tasks = nextTasks
    state.savedTasks = nextSavedTasks
    state.mutations = nextMutations
    state.loaded = true
    state.error = ''
  }

  async function performSave() {
    if (!hasUnsaved.value) return { success: true, message: '没有待保存修改' }
    const requestGeneration = generation
    const requestId = ++saveRequestId
    loadRequestId += 1
    state.saving = true
    try {
      const submitted = cloneMutation(mutationList.value)
      const result = await saver(submitted)
      if (!isCurrentRequest(requestGeneration, requestId, 'save')) return { ...result, ignored: true }
      reconcileSaveResult(submitted, result)
      try {
        await load({ preserveDraft: true, silent: true, allowDuringSave: true })
      } catch (refreshError) {
        if (isCurrentRequest(requestGeneration, requestId, 'save')) {
          state.error = `保存成功，但刷新最新数据失败：${refreshError.message}`
        }
      }
      if (!isCurrentRequest(requestGeneration, requestId, 'save')) return { ...result, ignored: true }
      return result
    } catch (error) {
      if (!isCurrentRequest(requestGeneration, requestId, 'save')) return { ignored: true }
      throw error
    } finally {
      if (isCurrentRequest(requestGeneration, requestId, 'save')) state.saving = false
    }
  }

  async function save() {
    if (savePromise) return savePromise
    const pending = performSave()
    savePromise = pending
    try {
      return await pending
    } finally {
      if (savePromise === pending) savePromise = null
    }
  }

  function reset() {
    generation += 1
    loadRequestId += 1
    saveRequestId += 1
    savePromise = null
    activeLoads.clear()
    foregroundLoads.clear()
    state.tasks = []
    state.savedTasks = {}
    state.mutations = {}
    state.loaded = false
    state.loading = false
    state.saving = false
    state.error = ''
    state.serverTime = null
  }

  return {
    state: readonly(state),
    tasks: visibleTasks,
    hasUnsaved,
    mutationList,
    load,
    addTask,
    updateTask,
    deleteTask,
    isDirty,
    discard,
    save,
    reset,
    _hydrateForTest: hydrate,
  }
}

export const scheduleTaskStore = createTaskDraftStore(getTasks)
export const myTaskStore = createTaskDraftStore(getMyTasks)

export function hasAnyUnsavedTasks() {
  return scheduleTaskStore.hasUnsaved.value || myTaskStore.hasUnsaved.value
}

export function hasAnyTaskSaveInProgress() {
  return scheduleTaskStore.state.saving || myTaskStore.state.saving
}

export function discardAllDrafts() {
  if (scheduleTaskStore.hasUnsaved.value) scheduleTaskStore.discard()
  if (myTaskStore.hasUnsaved.value) myTaskStore.discard()
}

export function resetAllTaskStores() {
  scheduleTaskStore.reset()
  myTaskStore.reset()
}
