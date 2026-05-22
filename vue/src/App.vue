<template>
  <n-config-provider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <AppShell />
        </n-notification-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup>
import { defineComponent, h, ref, computed, onMounted } from 'vue'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NLayoutFooter,
  NTag,
  NSpace,
  NDivider,
  NSpin,
  NEmpty,
  useMessage,
  useDialog,
  zhCN,
  dateZhCN,
} from 'naive-ui'
import { antdLikeTheme } from './theme.js'
import FilterPanel from './components/FilterPanel.vue'
import TaskEditor from './components/TaskEditor.vue'
import TaskList from './components/TaskList.vue'
import GanttChart from './components/GanttChart.vue'
import {
  loadTasksFromServer,
  saveTasksToServer,
  importToServer,
  exportFromServer,
  getAllTasks,
  getAllBots,
  filterTasks,
  addTask,
  updateTask,
  deleteTask,
  markAsChanged,
  markAsSaved,
  getHasUnsavedChanges,
} from './services/dataService.js'

const themeOverrides = antdLikeTheme

// 主体内容容器组件（放在 provider 内才能使用 useMessage / useDialog）
const AppShell = defineComponent({
  components: {
    FilterPanel,
    TaskEditor,
    TaskList,
    GanttChart,
    NLayout,
    NLayoutHeader,
    NLayoutContent,
    NLayoutFooter,
    NTag,
    NSpace,
    NDivider,
    NSpin,
    NEmpty,
  },
  setup() {
    const message = useMessage()
    const dialog = useDialog()

    const loading = ref(true)
    const allTasks = ref([])
    const allBots = ref([])

    // 筛选状态
    const searchTerm = ref('')
    const selectedBots = ref([])
    const sortBy = ref('bot')

    // 编辑器状态
    const editorVisible = ref(false)
    const editingTask = ref(null)
    const editorMode = ref('create') // 'create' | 'edit'

    // 派生筛选后的任务列表
    const filteredTasks = computed(() =>
      filterTasks(allTasks.value, {
        searchTerm: searchTerm.value,
        selectedBots: selectedBots.value,
        sortBy: sortBy.value,
      })
    )

    // 刷新内存数据快照
    function refreshSnapshot() {
      allTasks.value = getAllTasks()
      allBots.value = getAllBots()
    }

    async function loadData(silent = false) {
      loading.value = true
      try {
        await loadTasksFromServer()
        refreshSnapshot()
        if (!silent) message.success('数据已刷新')
      } catch (e) {
        message.error(`加载失败：${e.message}`)
      } finally {
        loading.value = false
      }
    }

    // 保存
    async function handleSave() {
      try {
        const result = await saveTasksToServer()
        markAsSaved()
        message.success(result.message || '保存成功')
      } catch (e) {
        message.error(`保存失败：${e.message}`)
      }
    }

    // 导入
    function handleImport(file) {
      const reader = new FileReader()
      reader.onload = async e => {
        const content = e.target.result
        const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv'
        try {
          const result = await importToServer(content, format)
          refreshSnapshot()
          message.success(result.message || '导入成功')
        } catch (err) {
          message.error(`导入失败：${err.message}`)
        }
      }
      reader.readAsText(file, 'utf-8')
    }

    function handleExport(format) {
      exportFromServer(format)
      message.success(`已导出 ${format.toUpperCase()} 文件`)
    }

    // 新增 / 编辑
    function handleCreate() {
      editorMode.value = 'create'
      editingTask.value = {
        task: '',
        bot: allBots.value[0] || '',
        start: '09:00:00',
        finish: '09:30:00',
      }
      editorVisible.value = true
    }

    function handleEdit(task) {
      editorMode.value = 'edit'
      editingTask.value = { ...task }
      editorVisible.value = true
    }

    function handleEditorSubmit(form) {
      if (editorMode.value === 'create') {
        addTask(form)
      } else {
        updateTask(form.id, form)
      }
      markAsChanged()
      refreshSnapshot()
      editorVisible.value = false
      message.info('已修改（点击「保存」生效到磁盘）')
    }

    function handleEditorDelete(id) {
      deleteTask(id)
      markAsChanged()
      refreshSnapshot()
      editorVisible.value = false
      message.info('已删除（点击「保存」生效到磁盘）')
    }

    // 从列表/甘特图发起的删除（无需进编辑器）
    function handleDelete(task) {
      dialog.warning({
        title: '确认删除',
        content: `确定要删除任务「${task.task}」吗？`,
        positiveText: '删除',
        negativeText: '取消',
        onPositiveClick: () => {
          deleteTask(task.id)
          markAsChanged()
          refreshSnapshot()
          message.info('已删除（点击「保存」生效到磁盘）')
        },
      })
    }

    // 甘特图拖拽更新时间
    function handleGanttUpdate({ id, start, finish }) {
      updateTask(id, { start, finish })
      markAsChanged()
      refreshSnapshot()
    }

    // 离开提示
    function beforeUnload(e) {
      if (getHasUnsavedChanges()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    onMounted(() => {
      loadData(true)
      window.addEventListener('beforeunload', beforeUnload)
    })

    // Logo SVG —— 3 根色条排列的甘特图意象
    function renderLogoIcon() {
      return h('span', { class: 'header-logo-icon' }, [
        h(
          'svg',
          { viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
          [
            h('rect', { x: '2', y: '3', width: '8', height: '2.2', rx: '1', fill: 'currentColor' }),
            h('rect', { x: '5', y: '7', width: '9', height: '2.2', rx: '1', fill: 'currentColor', opacity: '0.85' }),
            h('rect', { x: '3', y: '11', width: '7', height: '2.2', rx: '1', fill: 'currentColor', opacity: '0.7' }),
          ]
        ),
      ])
    }

    return () =>
      h(NLayout, { style: 'min-height: 100vh; background: #fafafa;' }, () => [
        // Header
        h(
          NLayoutHeader,
          {
            bordered: true,
            style:
              'background: #ffffff; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 1px 0 rgba(0,0,0,0.03);',
          },
          () => [
            // 左侧 Logo + 标题
            h('div', { class: 'header-logo' }, [
              renderLogoIcon(),
              h('div', { style: 'display: flex; flex-direction: column;' }, [
                h('span', { class: 'header-title' }, '任务甘特图编辑器'),
                h('span', { class: 'header-subtitle' }, '可视化任务编排'),
              ]),
            ]),
            // 右侧 状态 + 统计
            h('div', { class: 'header-stats' }, [
              getHasUnsavedChanges()
                ? h('span', { class: 'unsaved-dot' }, '未保存')
                : null,
              h('span', null, [
                '当前显示 ',
                h('span', { class: 'header-stat-num' }, filteredTasks.value.length),
                ' / ',
                h('span', { class: 'header-stat-num' }, allTasks.value.length),
                ' 条',
              ]),
            ]),
          ]
        ),
        // Content
        h(
          NLayoutContent,
          { contentStyle: 'padding: 24px; flex: 1;' },
          () =>
            loading.value
              ? h(
                  'div',
                  {
                    style:
                      'display:flex; align-items:center; justify-content:center; padding: 80px;',
                  },
                  h(NSpin, { size: 'large' })
                )
              : h(
                  'div',
                  {
                    style:
                      'display: grid; grid-template-columns: 1fr 304px; gap: 20px; align-items: start;',
                  },
                  [
                    // 左侧：甘特图 + 任务列表
                    h(
                      'div',
                      {
                        style: 'display: flex; flex-direction: column; gap: 20px;',
                      },
                      [
                        h(GanttChart, {
                          tasks: filteredTasks.value,
                          onTaskClick: handleEdit,
                          onTaskUpdate: handleGanttUpdate,
                        }),
                        h(TaskList, {
                          tasks: filteredTasks.value,
                          onEdit: handleEdit,
                          onDelete: handleDelete,
                        }),
                      ]
                    ),
                    // 右侧：筛选与操作
                    h(FilterPanel, {
                      searchTerm: searchTerm.value,
                      selectedBots: selectedBots.value,
                      sortBy: sortBy.value,
                      allBots: allBots.value,
                      allTasks: allTasks.value,
                      filteredCount: filteredTasks.value.length,
                      totalCount: allTasks.value.length,
                      'onUpdate:searchTerm': v => (searchTerm.value = v),
                      'onUpdate:selectedBots': v => (selectedBots.value = v),
                      'onUpdate:sortBy': v => (sortBy.value = v),
                      onRefresh: () => loadData(),
                      onImport: handleImport,
                      onExport: handleExport,
                      onCreate: handleCreate,
                      onSave: handleSave,
                    }),
                  ]
                )
        ),
        // Footer
        h(
          NLayoutFooter,
          {
            bordered: true,
            style:
              'background: #ffffff; padding: 12px 24px; text-align: center; color: rgba(0,0,0,0.45); font-size: 12px;',
          },
          () => 'PyTaskGantt · Vue 3 + Naive UI + vis-timeline'
        ),
        // 编辑器 Modal
        h(TaskEditor, {
          show: editorVisible.value,
          mode: editorMode.value,
          task: editingTask.value,
          allBots: allBots.value,
          'onUpdate:show': v => (editorVisible.value = v),
          onSubmit: handleEditorSubmit,
          onDelete: handleEditorDelete,
        }),
      ])
  },
})
</script>
