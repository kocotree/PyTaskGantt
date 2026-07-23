<template>
  <AppShell>
    <section class="page-heading">
      <div>
        <h1>全员任务沙盘</h1>
        <p>所有登录用户均可查看；仅任务所有者可编辑和拖拽。</p>
      </div>
      <div class="page-heading-meta">
        <n-tag v-if="store.hasUnsaved.value" type="warning" :bordered="false">
          {{ store.mutationList.value.length }} 项待保存
        </n-tag>
        <span>影刀数据截至 {{ syncCutoffText }}</span>
      </div>
    </section>

    <n-alert v-if="store.state.error" type="error" :show-icon="true" class="page-alert">
      {{ store.state.error }}
    </n-alert>

    <n-spin :show="store.state.loading">
      <div class="schedule-layout">
        <div class="schedule-main">
          <GanttChart
            :tasks="filteredTasks"
            @task-click="handleTaskClick"
            @task-update="handleGanttUpdate"
          />
          <TaskList :tasks="filteredTasks" @edit="openEdit" @delete="confirmDelete" @history="openHistory" />
        </div>
        <aside class="schedule-sidebar">
          <FilterPanel
            v-model:search-term="searchTerm"
            v-model:selected-bots="selectedBots"
            v-model:selected-owners="selectedOwners"
            v-model:sort-by="sortBy"
            :all-bots="allBots"
            :all-owners="allOwners"
            :filtered-count="filteredTasks.length"
            :total-count="store.tasks.value.length"
            :has-unsaved="store.hasUnsaved.value"
            :mutation-count="store.mutationList.value.length"
            :saving="store.state.saving"
            @refresh="confirmRefresh"
            @import="handleImport"
            @export="handleExport"
            @create="openCreate"
            @save="handleSave"
          />
        </aside>
      </div>
    </n-spin>

    <TaskEditor
      v-model:show="editorVisible"
      :mode="editorMode"
      :task="editingTask"
      :all-bots="allBots"
      :all-tags="allTags"
      :reserved-schedule-uuids="reservedScheduleUuids"
      @submit="handleEditorSubmit"
      @delete="handleEditorDelete"
    />
    <ExecutionHistoryDialog v-model:show="historyVisible" :task="historyTask" />
  </AppShell>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import AppShell from '../components/AppShell.vue'
import ExecutionHistoryDialog from '../components/ExecutionHistoryDialog.vue'
import FilterPanel from '../components/FilterPanel.vue'
import GanttChart from '../components/GanttChart.vue'
import TaskEditor from '../components/TaskEditor.vue'
import TaskList from '../components/TaskList.vue'
import { auth } from '../services/authService.js'
import { filterTasks, formatDateTime, summarizeSyncCutoff } from '../services/dataService.js'
import { exportTasks, importTasks } from '../services/taskService.js'
import { scheduleTaskStore as store } from '../stores/taskDraftStore.js'

const message = useMessage()
const dialog = useDialog()
const searchTerm = ref('')
const selectedBots = ref([])
const selectedOwners = ref([])
const sortBy = ref('bot')
const editorVisible = ref(false)
const editorMode = ref('create')
const editingTask = ref(null)
const historyVisible = ref(false)
const historyTask = ref(null)
const refreshSeconds = Math.max(5, Number(auth.uiRefreshSeconds || 10))
let refreshTimer = null

const syncCutoffText = computed(() => {
  const cutoff = summarizeSyncCutoff(store.tasks.value)
  if (!cutoff.boundCount) return '无已绑定任务'
  if (!cutoff.timestamp) return '尚未成功同步'
  return `${formatDateTime(cutoff.timestamp)}${cutoff.incomplete ? '（部分任务尚未同步）' : ''}`
})

const allBots = computed(() => [...new Set(store.tasks.value.map(task => task.bot).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const allTags = computed(() => [...new Set(store.tasks.value.flatMap(task => task.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN')))
const allOwners = computed(() => {
  const map = new Map()
  for (const task of store.tasks.value) {
    if (task.owner) map.set(String(task.owner.id), task.owner)
  }
  if (store.tasks.value.some(task => !task.owner)) map.set('legacy', { id: 'legacy', display_name: '历史任务' })
  return [...map.values()]
})
const filteredTasks = computed(() => filterTasks(store.tasks.value, {
  searchTerm: searchTerm.value,
  selectedBots: selectedBots.value,
  selectedOwners: selectedOwners.value,
  sortBy: sortBy.value,
}))
const reservedScheduleUuids = computed(() => store.tasks.value
  .filter(task => task.id !== editingTask.value?.id)
  .map(task => task.schedule_uuid)
  .filter(Boolean))

onMounted(async () => {
  try {
    await store.load({ preserveDraft: true })
  } catch (error) {
    message.error(`任务加载失败：${error.message}`)
  }
  refreshTimer = window.setInterval(pollTasks, refreshSeconds * 1000)
  window.addEventListener('beforeunload', beforeUnload)
})

onBeforeUnmount(() => {
  window.clearInterval(refreshTimer)
  window.removeEventListener('beforeunload', beforeUnload)
})

function beforeUnload(event) {
  if (!store.hasUnsaved.value) return
  event.preventDefault()
  event.returnValue = ''
}

function pollTasks() {
  if (store.state.loading || store.state.saving) return
  store.load({ preserveDraft: true, silent: true }).catch(() => {})
}

function openCreate() {
  editorMode.value = 'create'
  editingTask.value = { task: '', bot: allBots.value[0] || '', start: '09:00:00', finish: '09:30:00', tags: [], note: '' }
  editorVisible.value = true
}

function openEdit(task) {
  if (!task.can_edit) return message.warning('该任务属于其他用户或为历史未绑定任务，仅可查看。')
  editorMode.value = 'edit'
  editingTask.value = { ...task, tags: [...(task.tags || [])] }
  editorVisible.value = true
}

function handleTaskClick(task) {
  if (!task.can_edit) return message.info(`“${task.task}”由 ${task.owner?.display_name || '历史数据'} 管理，当前为只读。`)
  openEdit(task)
}

function openHistory(task) {
  historyTask.value = task
  historyVisible.value = true
}

function handleGanttUpdate({ id, start, finish }) {
  if (!store.updateTask(id, { start, finish })) message.warning('该任务不可编辑')
}

function handleEditorSubmit(form) {
  if (editorMode.value === 'create') store.addTask(form)
  else store.updateTask(form.id, form)
  editorVisible.value = false
  message.info('已加入草稿，点击“保存”后写入数据库。')
}

function handleEditorDelete(id) {
  store.deleteTask(id)
  editorVisible.value = false
  message.info('已加入删除草稿，点击“保存”后生效。')
}

function confirmDelete(task) {
  dialog.warning({
    title: '确认删除',
    content: `删除“${task.task}”将在点击保存后生效，并释放当前绑定计划。`,
    positiveText: '加入删除草稿', negativeText: '取消',
    onPositiveClick: () => store.deleteTask(task.id),
  })
}

async function handleSave() {
  try {
    const result = await store.save()
    if (result.ignored) return
    message.success(result.message || '任务修改已保存')
  } catch (error) {
    const details = Array.isArray(error.details) ? `：${error.details.map(item => item.task || item.id || item.message).join('、')}` : ''
    message.error(`保存失败${details || `：${error.message}`}`)
  }
}

function confirmRefresh() {
  if (!store.hasUnsaved.value) return store.load({ preserveDraft: false }).then(() => message.success('数据已刷新')).catch(error => message.error(error.message))
  dialog.warning({
    title: '丢弃未保存修改？',
    content: '刷新会丢弃当前全部任务草稿并重新读取数据库。',
    positiveText: '丢弃并刷新', negativeText: '取消',
    onPositiveClick: () => store.load({ preserveDraft: false }).then(() => message.success('已丢弃草稿并刷新')),
  })
}

async function handleImport(file) {
  try {
    const content = await file.text()
    const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'
    const result = await importTasks(content, format)
    await store.load({ preserveDraft: true, silent: true })
    message.success(result.message || '导入完成')
  } catch (error) {
    message.error(`导入失败：${error.message}`)
  }
}

async function handleExport(format) {
  try {
    await exportTasks(format)
    message.success(`已导出 ${format.toUpperCase()} 文件`)
  } catch (error) {
    message.error(`导出失败：${error.message}`)
  }
}
</script>
