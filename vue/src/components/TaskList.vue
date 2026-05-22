<template>
  <n-card title="任务列表" size="small" :bordered="true">
    <template #header-extra>
      <n-text depth="3" style="font-size: 12px;">共 {{ tasks.length }} 条</n-text>
    </template>
    <n-empty
      v-if="!tasks.length"
      description="暂无任务，点击右侧「新增任务」开始"
      style="padding: 32px 0;"
    />
    <n-data-table
      v-else
      :columns="columns"
      :data="tasks"
      :pagination="{ pageSize: 10, showSizePicker: false, size: 'small', prefix: ({ itemCount }) => `共 ${itemCount} 条` }"
      :max-height="360"
      size="small"
      :bordered="false"
      :single-line="false"
      :striped="true"
      :row-key="row => row.id"
      :row-props="getRowProps"
    />
  </n-card>
</template>

<script setup>
import { h, computed } from 'vue'
import {
  NCard,
  NText,
  NDataTable,
  NTag,
  NButton,
  NSpace,
  NPopconfirm,
  NIcon,
  NEmpty,
} from 'naive-ui'

const props = defineProps({
  tasks: { type: Array, required: true },
})

const emit = defineEmits(['edit', 'delete'])

// 行 props（鼠标 cursor 指示可点击）
function getRowProps(row) {
  return {
    style: 'cursor: default;',
    onClick: () => {
      // 不直接编辑，避免误触；编辑通过操作列按钮
    },
  }
}

// 图标
const iconStyle = { width: '14px', height: '14px' }
const PencilIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('path', { d: 'M12 20h9' }),
      h('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }),
    ]
  )
const TrashIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('polyline', { points: '3 6 5 6 21 6' }),
      h('path', { d: 'M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
    ]
  )

const columns = computed(() => [
  {
    title: '任务名称',
    key: 'task',
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: '开始',
    key: 'start',
    width: 90,
    render(row) {
      return h('span', { class: 'time-chip' }, row.start.substring(0, 5))
    },
  },
  {
    title: '结束',
    key: 'finish',
    width: 110,
    render(row) {
      return h('span', { style: 'display: inline-flex; align-items: center; gap: 4px;' }, [
        h('span', { class: 'time-chip' }, row.finish.substring(0, 5)),
        row.crossDay
          ? h(
              NTag,
              { size: 'small', type: 'warning', bordered: false },
              () => '次日'
            )
          : null,
      ])
    },
  },
  {
    title: '机器人',
    key: 'bot',
    width: 110,
    render(row) {
      return h(
        NTag,
        {
          size: 'small',
          bordered: false,
          color: { color: row.color, textColor: '#ffffff' },
        },
        () => row.bot
      )
    },
  },
  {
    title: '时长',
    key: 'duration',
    width: 80,
    render(row) {
      return h('span', { style: 'color: rgba(0,0,0,0.45);' }, row.duration)
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    align: 'center',
    render(row) {
      return h(NSpace, { size: 4, justify: 'center' }, () => [
        h(
          NButton,
          {
            quaternary: true,
            size: 'tiny',
            type: 'primary',
            onClick: () => emit('edit', row),
            title: '编辑',
          },
          { icon: () => h(NIcon, null, { default: () => h(PencilIcon) }) }
        ),
        h(
          NPopconfirm,
          {
            onPositiveClick: () => emit('delete', row),
            positiveText: '删除',
            negativeText: '取消',
          },
          {
            trigger: () =>
              h(
                NButton,
                {
                  quaternary: true,
                  size: 'tiny',
                  type: 'error',
                  title: '删除',
                },
                { icon: () => h(NIcon, null, { default: () => h(TrashIcon) }) }
              ),
            default: () => `确定删除「${row.task}」？`,
          }
        ),
      ])
    },
  },
])
</script>
