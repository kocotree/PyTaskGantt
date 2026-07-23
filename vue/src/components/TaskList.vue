<template>
  <n-card title="任务列表" size="small" :bordered="true" class="task-list-card">
    <template #header-extra><n-text depth="3">共 {{ tasks.length }} 条</n-text></template>
    <n-empty v-if="!tasks.length" description="暂无符合条件的任务" class="table-empty" />
    <n-data-table
      v-else
      :columns="columns"
      :data="tasks"
      :pagination="{ pageSize: 10, size: 'small' }"
      :row-key="row => row.id"
      :row-class-name="row => row.can_edit ? '' : 'locked-task-row'"
      :scroll-x="1120"
      size="small"
      :bordered="false"
      :single-line="false"
      striped
    />
  </n-card>
</template>

<script setup>
import { computed, h } from 'vue'
import { NButton, NCard, NDataTable, NEmpty, NSpace, NTag, NText } from 'naive-ui'
import { statusType } from '../services/dataService.js'

const props = defineProps({ tasks: { type: Array, required: true } })
const emit = defineEmits(['edit', 'delete', 'history', 'locked-click'])

const columns = computed(() => [
  {
    title: '任务名称', key: 'task', minWidth: 180, ellipsis: { tooltip: true },
    render(row) {
      return h('div', { class: 'task-name-cell' }, [
        h('span', row.task),
        row.is_legacy_unbound ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => '待绑定/只读') : null,
      ])
    },
  },
  {
    title: '所有者', key: 'owner', width: 120,
    render: row => h('span', { class: 'owner-cell' }, row.owner?.display_name || '历史任务'),
  },
  {
    title: '开始', key: 'start', width: 88,
    render: row => h('span', { class: 'time-chip' }, row.start.slice(0, 5)),
  },
  {
    title: '结束', key: 'finish', width: 105,
    render(row) {
      return h(NSpace, { size: 4, wrap: false }, () => [
        h('span', { class: 'time-chip' }, row.finish.slice(0, 5)),
        row.crossDay ? h(NTag, { size: 'small', type: 'warning', bordered: false }, () => '次日') : null,
      ])
    },
  },
  {
    title: 'Bot', key: 'bot', width: 120,
    render: row => h(NTag, { size: 'small', bordered: false, color: { color: row.color, textColor: '#fff' } }, () => row.bot),
  },
  {
    title: '状态', key: 'normalized_status', width: 105,
    render: row => h(NTag, { size: 'small', bordered: false, type: statusType(row.normalized_status) }, () => row.normalized_status),
  },
  {
    title: '操作', key: 'actions', width: 132, fixed: 'right', align: 'center',
    render(row) {
      if (!row.can_edit) {
        return h(NSpace, { size: 4, justify: 'center', wrap: false }, () => [
          h(NButton, { size: 'tiny', quaternary: true, onClick: () => emit('history', row) }, () => '历史'),
          h(NButton, { size: 'tiny', disabled: true, title: '仅任务所有者可编辑' }, () => '已锁定'),
        ])
      }
      return h(NSpace, { size: 4, justify: 'center', wrap: false }, () => [
        h(NButton, { size: 'tiny', type: 'primary', quaternary: true, onClick: () => emit('edit', row) }, () => '编辑'),
        h(NButton, { size: 'tiny', type: 'error', quaternary: true, onClick: () => emit('delete', row) }, () => '删除'),
        h(NButton, { size: 'tiny', quaternary: true, onClick: () => emit('history', row) }, () => '历史'),
      ])
    },
  },
])
</script>
