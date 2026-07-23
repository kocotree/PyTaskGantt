<template>
  <AppShell>
    <section class="page-heading">
      <div>
        <h1>全员任务沙盘</h1>
        <p>所有登录用户均可查看；任务所有者与管理员可维护有效任务。</p>
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
          <TaskList
            :tasks="filteredTasks"
            :can-recover="Boolean(auth.user?.is_admin)"
            @edit="openEdit"
            @delete="confirmDelete"
            @history="openHistory"
            @run="confirmRun"
            @sync="syncOne"
            @rebind="openRebind"
            @transfer="openTransfer"
            @recover="openRecovery"
          />
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
    <n-modal v-model:show="rebindVisible" preset="card" title="换绑影刀计划" class="responsive-modal compact-modal">
      <p class="dialog-description">任务所有者不会改变；新绑定只接收绑定时间之后的执行记录。</p>
      <SchedulePicker
        v-model="rebindScheduleUuid"
        :selected-name="actionTask?.schedule_name || ''"
        :reserved-uuids="reservedScheduleUuids"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="rebindVisible = false">取消</n-button>
          <n-button type="primary" :disabled="!rebindScheduleUuid || rebindScheduleUuid === actionTask?.schedule_uuid" :loading="actionLoading" @click="confirmRebind">确认换绑</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="transferVisible" preset="card" title="转交任务所有权" class="responsive-modal compact-modal">
      <p class="dialog-description">仅明确转交会改变任务所有者；计划绑定和执行历史保持不变。</p>
      <n-select v-model:value="targetUserId" :options="transferUserOptions" filterable placeholder="选择接收用户" />
      <template #footer>
        <n-space justify="end">
          <n-button @click="transferVisible = false">取消</n-button>
          <n-button type="warning" :disabled="!targetUserId" :loading="actionLoading" @click="confirmTransfer">确认转交</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="recoveryVisible" preset="card" title="分配并绑定历史任务" class="responsive-modal compact-modal">
      <n-alert type="warning" :show-icon="true" class="page-alert">
        绑定从服务器当前时间生效，恢复前的执行记录不会移动到新绑定。
      </n-alert>
      <p class="dialog-description">
        任务：{{ actionTask?.task }}（ID {{ actionTask?.id }}） · 当前版本 {{ actionTask?.version }}
      </p>
      <n-select v-model:value="recoveryOwnerUserId" :options="recoveryUserOptions" filterable placeholder="选择目标用户" />
      <div style="height: 12px"></div>
      <SchedulePicker
        v-model="recoveryScheduleUuid"
        :selected-name="actionTask?.schedule_name || ''"
        :reserved-uuids="reservedScheduleUuids"
        :include-bound="true"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="recoveryVisible = false">取消</n-button>
          <n-button type="primary" :disabled="!recoveryOwnerUserId || !recoveryScheduleUuid" :loading="actionLoading" @click="confirmRecovery">确认分配并绑定</n-button>
        </n-space>
      </template>
    </n-modal>
    <ExecutionHistoryDialog v-model:show="historyVisible" :task="historyTask" />
  </AppShell>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NModal, NSelect, NSpace, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import AppShell from '../components/AppShell.vue'
import ExecutionHistoryDialog from '../components/ExecutionHistoryDialog.vue'
import FilterPanel from '../components/FilterPanel.vue'
import GanttChart from '../components/GanttChart.vue'
import SchedulePicker from '../components/SchedulePicker.vue'
import TaskEditor from '../components/TaskEditor.vue'
import TaskList from '../components/TaskList.vue'
import { auth } from '../services/authService.js'
import { filterTasks, formatDateTime, summarizeSyncCutoff } from '../services/dataService.js'
import {
  exportTasks,
  getUsers,
  importTasks,
  rebindTask,
  recoverTask,
  runTask,
  syncTask,
  transferTask,
} from '../services/taskService.js'
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
const actionTask = ref(null)
const users = ref([])
const actionLoading = ref(false)
const rebindVisible = ref(false)
const rebindScheduleUuid = ref('')
const transferVisible = ref(false)
const targetUserId = ref(null)
const recoveryVisible = ref(false)
const recoveryOwnerUserId = ref(null)
const recoveryScheduleUuid = ref('')
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
  .filter(task => task.id !== editingTask.value?.id && task.id !== actionTask.value?.id)
  .map(task => task.schedule_uuid)
  .filter(Boolean))
const recoveryUserOptions = computed(() => users.value.map(user => ({
  label: user.display_name,
  value: String(user.id),
})))
const transferUserOptions = computed(() => recoveryUserOptions.value
  .filter(option => option.value !== String(actionTask.value?.owner?.id || '')))

onMounted(async () => {
  try {
    await store.load({ preserveDraft: true })
  } catch (error) {
    message.error(`任务加载失败：${error.message}`)
  }
  getUsers().then(result => { users.value = result }).catch(() => {})
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

function ensureImmediateAction(task) {
  if (!store.isDirty(task.id)) return true
  message.warning('该任务有未保存草稿，请先保存或刷新后再执行立即操作。')
  return false
}

function openRebind(task) {
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  rebindScheduleUuid.value = task.schedule_uuid
  rebindVisible.value = true
}

function openTransfer(task) {
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  targetUserId.value = null
  transferVisible.value = true
}

function openRecovery(task) {
  if (!auth.user?.is_admin) return message.error('仅管理员可恢复历史任务')
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  recoveryOwnerUserId.value = task.owner?.id ? String(task.owner.id) : null
  recoveryScheduleUuid.value = task.schedule_uuid || ''
  recoveryVisible.value = true
}

function actionError(prefix, error) {
  const hints = {
    ADMIN_REQUIRED: '当前账号已不具备管理员权限，请刷新会话。',
    VERSION_CONFLICT: '任务版本已变化，请刷新后重试。',
    SCHEDULE_ALREADY_BOUND: '所选计划已被其他有效任务占用。',
    TASK_ALREADY_ACTIVE: '该任务已是正常有效任务，请使用转交或换绑。',
  }
  message.error(`${prefix}：${hints[error.code] || error.message}`)
}

async function syncOne(task) {
  try {
    const result = await syncTask(task.id)
    message.success(result.message || '任务同步完成')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('同步失败', error)
  }
}

function confirmRun(task) {
  if (!ensureImmediateAction(task)) return
  dialog.warning({
    title: '立即执行影刀计划',
    content: `确定立即执行“${task.task}”吗？任务所有者不会因此改变。`,
    positiveText: '立即执行',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await runTask(task.id)
        message.success(result.task_uuid ? `影刀已受理，执行 UUID：${result.task_uuid}` : '影刀已受理')
        await store.load({ preserveDraft: true, silent: true })
      } catch (error) {
        actionError('执行失败', error)
      }
    },
  })
}

async function confirmRebind() {
  actionLoading.value = true
  try {
    await rebindTask(actionTask.value.id, rebindScheduleUuid.value, actionTask.value.version)
    rebindVisible.value = false
    message.success('计划换绑成功')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('换绑失败', error)
  } finally {
    actionLoading.value = false
  }
}

async function confirmTransfer() {
  actionLoading.value = true
  try {
    await transferTask(actionTask.value.id, targetUserId.value, actionTask.value.version)
    transferVisible.value = false
    message.success('任务已转交')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('转交失败', error)
  } finally {
    actionLoading.value = false
  }
}

async function confirmRecovery() {
  actionLoading.value = true
  try {
    await recoverTask(
      actionTask.value.id,
      recoveryOwnerUserId.value,
      recoveryScheduleUuid.value,
      actionTask.value.version
    )
    recoveryVisible.value = false
    message.success('历史任务已完成分配和绑定')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    actionError('恢复失败', error)
  } finally {
    actionLoading.value = false
  }
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
