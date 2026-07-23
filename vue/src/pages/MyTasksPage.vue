<template>
  <AppShell>
    <section class="page-heading my-tasks-heading">
      <div>
        <h1>我的任务</h1>
        <p>管理我拥有的计划绑定、运行状态、执行记录和日志。</p>
      </div>
      <n-space>
        <n-button :loading="syncing" @click="syncAll">同步我的任务</n-button>
        <n-button @click="openCreate">新增任务</n-button>
        <n-button
          type="primary"
          :disabled="!store.hasUnsaved.value"
          :loading="store.state.saving"
          @click="saveDrafts"
        >
          保存{{ store.hasUnsaved.value ? `（${store.mutationList.value.length}）` : '' }}
        </n-button>
      </n-space>
    </section>

    <n-alert v-if="syncErrors.length" type="warning" :show-icon="true" class="page-alert">
      {{ syncErrors.length }} 个任务最近同步失败；已保留上次有效状态。最新错误：{{ syncErrors[0].sync_error }}
    </n-alert>

    <n-alert v-if="store.state.error" type="error" :show-icon="true" class="page-alert">
      任务列表刷新失败，当前保留上次成功读取的数据：{{ store.state.error }}
    </n-alert>

    <n-card size="small" class="my-task-filter-card">
      <div class="my-task-filters">
        <n-input v-model:value="query" clearable placeholder="搜索任务名称" />
        <n-select v-model:value="selectedTags" :options="tagOptions" multiple clearable placeholder="标签" />
        <n-select v-model:value="selectedStatuses" :options="statusOptions" multiple clearable placeholder="运行状态" />
        <n-select v-model:value="sort" :options="sortOptions" />
        <span class="data-cutoff">影刀数据截至 {{ syncCutoffText }}</span>
      </div>
    </n-card>

    <n-spin :show="store.state.loading">
      <n-card title="个人任务列表" size="small" class="my-task-table-card">
        <template #header-extra><span>{{ filteredTasks.length }} 个任务</span></template>
        <n-empty v-if="!filteredTasks.length" description="暂无符合条件的个人任务" class="table-empty" />
        <n-data-table
          v-else
          :columns="columns"
          :data="filteredTasks"
          :pagination="{ pageSize: 15, showSizePicker: false }"
          :row-key="row => row.id"
          :scroll-x="1710"
          size="small"
          :single-line="false"
          striped
        />
      </n-card>
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
      <p class="dialog-description">换绑后，旧计划的执行历史仍保留在任务下；新绑定只接收绑定时间之后的记录。</p>
      <SchedulePicker
        v-model="rebindScheduleUuid"
        :selected-name="actionTask?.schedule_name || ''"
        :reserved-uuids="reservedScheduleUuids"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="rebindVisible = false">取消</n-button>
          <n-button
            type="primary"
            :disabled="!rebindScheduleUuid || rebindScheduleUuid === actionTask?.schedule_uuid"
            :loading="actionLoading"
            @click="confirmRebind"
          >确认换绑</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="transferVisible" preset="card" title="转交任务所有权" class="responsive-modal compact-modal">
      <p class="dialog-description">转交立即生效，计划绑定、标签、备注和全部执行历史会随任务保留。</p>
      <n-select v-model:value="targetUserId" :options="transferUserOptions" filterable placeholder="选择接收用户" />
      <template #footer>
        <n-space justify="end">
          <n-button @click="transferVisible = false">取消</n-button>
          <n-button type="warning" :disabled="!targetUserId" :loading="actionLoading" @click="confirmTransfer">确认转交</n-button>
        </n-space>
      </template>
    </n-modal>

    <ExecutionHistoryDialog v-model:show="historyVisible" :task="actionTask" />
  </AppShell>
</template>

<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDropdown,
  NEmpty,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import AppShell from '../components/AppShell.vue'
import ExecutionHistoryDialog from '../components/ExecutionHistoryDialog.vue'
import SchedulePicker from '../components/SchedulePicker.vue'
import TaskEditor from '../components/TaskEditor.vue'
import { auth } from '../services/authService.js'
import { decorateTask, formatDateTime, statusType, summarizeSyncCutoff } from '../services/dataService.js'
import { getUsers, rebindTask, runTask, syncMyTasks, syncTask, transferTask } from '../services/taskService.js'
import { myTaskStore as store } from '../stores/taskDraftStore.js'

const message = useMessage()
const dialog = useDialog()
const query = ref('')
const selectedTags = ref([])
const selectedStatuses = ref([])
const sort = ref('updated')
const editorVisible = ref(false)
const editorMode = ref('create')
const editingTask = ref(null)
const historyVisible = ref(false)
const rebindVisible = ref(false)
const transferVisible = ref(false)
const actionTask = ref(null)
const rebindScheduleUuid = ref('')
const targetUserId = ref(null)
const users = ref([])
const syncing = ref(false)
const actionLoading = ref(false)
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
const tagOptions = computed(() => allTags.value.map(value => ({ label: value, value })))
const syncErrors = computed(() => store.tasks.value.filter(task => task.sync_error))
const reservedScheduleUuids = computed(() => store.tasks.value
  .filter(task => task.id !== actionTask.value?.id && task.id !== editingTask.value?.id)
  .map(task => task.schedule_uuid).filter(Boolean))
const statusOptions = ['待运行', '等待中', '运行中', '等待超时', '运行超时', '运行成功', '运行失败', '已停止', '未知状态']
  .map(value => ({ label: value, value }))
const sortOptions = [
  { label: '最近更新', value: 'updated' },
  { label: '任务名称', value: 'name' },
  { label: '最后运行', value: 'last_run' },
  { label: '运行状态', value: 'status' },
]
const transferUserOptions = computed(() => users.value
  .filter(user => String(user.id) !== String(auth.user?.id))
  .map(user => ({ label: user.display_name, value: String(user.id) })))

const filteredTasks = computed(() => {
  const term = query.value.trim().toLocaleLowerCase('zh-CN')
  const rows = store.tasks.value.map(decorateTask).filter(task => {
    if (term && !task.task.toLocaleLowerCase('zh-CN').includes(term)) return false
    if (selectedTags.value.length && !selectedTags.value.every(tag => task.tags.includes(tag))) return false
    if (selectedStatuses.value.length && !selectedStatuses.value.includes(task.normalized_status)) return false
    return true
  })
  rows.sort((left, right) => {
    if (sort.value === 'name') return left.task.localeCompare(right.task, 'zh-CN')
    if (sort.value === 'last_run') return String(right.last_run_at || '').localeCompare(String(left.last_run_at || ''))
    if (sort.value === 'status') return left.normalized_status.localeCompare(right.normalized_status, 'zh-CN')
    return String(right.updated_at || right.last_synced_at || '').localeCompare(String(left.updated_at || left.last_synced_at || ''))
  })
  return rows
})

const columns = computed(() => [
  { title: '任务名称', key: 'task', width: 190, ellipsis: { tooltip: true } },
  {
    title: '标签', key: 'tags', width: 180,
    render: row => h(NSpace, { size: 4 }, () => (row.tags.length ? row.tags : ['—']).map(tag => h(NTag, { size: 'small', bordered: false }, () => tag))),
  },
  { title: '时间', key: 'time', width: 150, render: row => `${row.start.slice(0, 5)} → ${row.finish.slice(0, 5)}${row.crossDay ? '（次日）' : ''}` },
  { title: 'Bot', key: 'bot', width: 120, ellipsis: { tooltip: true } },
  {
    title: '最新状态', key: 'normalized_status', width: 110,
    render: row => h(NTag, { size: 'small', bordered: false, type: statusType(row.normalized_status) }, () => row.normalized_status),
  },
  { title: '最后运行', key: 'last_run_at', width: 145, render: row => formatDateTime(row.last_run_at) },
  { title: '数据截至', key: 'last_synced_at', width: 145, render: row => formatDateTime(row.last_synced_at) },
  { title: '备注', key: 'note', minWidth: 180, ellipsis: { tooltip: true }, render: row => row.note || '—' },
  {
    title: '操作', key: 'actions', width: 280, fixed: 'right',
    render(row) {
      return h(NSpace, { size: 4, wrap: false }, () => [
        h(NButton, { size: 'tiny', type: 'primary', quaternary: true, onClick: () => openEdit(row) }, () => '编辑'),
        h(NButton, { size: 'tiny', type: 'success', quaternary: true, onClick: () => confirmRun(row) }, () => '立即执行'),
        h(NButton, { size: 'tiny', quaternary: true, onClick: () => openHistory(row) }, () => '历史'),
        h(NDropdown, {
          trigger: 'click',
          options: [
            { label: '同步此任务', key: 'sync' },
            { label: '换绑计划', key: 'rebind' },
            { label: '转交所有权', key: 'transfer' },
            { label: '删除任务（待保存）', key: 'delete' },
          ],
          onSelect: key => handleMore(key, row),
        }, { default: () => h(NButton, { size: 'tiny', quaternary: true }, () => '更多') }),
      ])
    },
  },
])

onMounted(async () => {
  try {
    await store.load({ preserveDraft: true })
  } catch (error) {
    message.error(`个人任务加载失败：${error.message}`)
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

function ensureImmediateAction(task) {
  if (!store.isDirty(task.id)) return true
  message.warning('该任务有未保存草稿，请先保存或刷新后再执行立即操作。')
  return false
}

function openCreate() {
  editorMode.value = 'create'
  editingTask.value = { task: '', bot: allBots.value[0] || '', start: '09:00:00', finish: '09:30:00', tags: [], note: '' }
  editorVisible.value = true
}

function openEdit(task) {
  editorMode.value = 'edit'
  editingTask.value = { ...task, tags: [...task.tags] }
  editorVisible.value = true
}

function handleEditorSubmit(form) {
  if (editorMode.value === 'create') store.addTask(form)
  else store.updateTask(form.id, form)
  editorVisible.value = false
  message.info('修改已加入草稿，请点击页面右上角“保存”。')
}

function handleEditorDelete(id) {
  store.deleteTask(id)
  editorVisible.value = false
}

async function saveDrafts() {
  try {
    const result = await store.save()
    if (result.ignored) return
    message.success(result.message || '任务修改已保存')
  } catch (error) {
    message.error(`保存失败：${error.message}`)
  }
}

async function syncAll() {
  syncing.value = true
  try {
    const result = await syncMyTasks()
    message.success(result.message || '同步请求已受理')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    message.error(`同步失败：${error.message}`)
  } finally {
    syncing.value = false
  }
}

function openHistory(task) {
  actionTask.value = task
  historyVisible.value = true
}

function handleMore(key, task) {
  if (key === 'delete') return confirmDelete(task)
  if (key === 'sync') return syncOne(task)
  if (!ensureImmediateAction(task)) return
  actionTask.value = task
  if (key === 'rebind') {
    rebindScheduleUuid.value = task.schedule_uuid
    rebindVisible.value = true
  } else if (key === 'transfer') {
    targetUserId.value = null
    transferVisible.value = true
  }
}

async function syncOne(task) {
  try {
    const result = await syncTask(task.id)
    message.success(result.message || '任务同步已受理')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    message.error(`同步失败：${error.message}`)
  }
}

function confirmDelete(task) {
  dialog.warning({
    title: '删除任务',
    content: `删除“${task.task}”将在点击保存后生效，并释放当前 scheduleUuid；影刀计划本身不会被删除。`,
    positiveText: '加入删除草稿', negativeText: '取消',
    onPositiveClick: () => store.deleteTask(task.id),
  })
}

function confirmRun(task) {
  if (!ensureImmediateAction(task)) return
  dialog.warning({
    title: '立即执行影刀计划',
    content: `确定立即执行“${task.task}”吗？系统会使用影刀计划中已有的运行参数。`,
    positiveText: '立即执行', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await runTask(task.id)
        message.success(result.task_uuid ? `影刀已受理，执行 UUID：${result.task_uuid}` : (result.message || '影刀已受理'))
        await store.load({ preserveDraft: true, silent: true })
      } catch (error) {
        message.error(`执行失败：${error.message}`)
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
    message.error(`换绑失败：${error.message}`)
  } finally {
    actionLoading.value = false
  }
}

async function confirmTransfer() {
  actionLoading.value = true
  try {
    await transferTask(actionTask.value.id, targetUserId.value, actionTask.value.version)
    transferVisible.value = false
    message.success('任务已转交，新所有者立即获得写权限')
    await store.load({ preserveDraft: true, silent: true })
  } catch (error) {
    message.error(`转交失败：${error.message}`)
  } finally {
    actionLoading.value = false
  }
}
</script>
