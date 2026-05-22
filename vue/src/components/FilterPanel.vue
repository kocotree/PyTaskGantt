<template>
  <n-card title="筛选与操作" size="small" :bordered="true" class="filter-panel">
    <!-- 分区一：数据 -->
    <div class="filter-section">
      <div class="section-title">
        <span>数据</span>
      </div>
      <n-button-group size="small" style="width: 100%; display: flex;">
        <n-button @click="$emit('refresh')" style="flex: 1;" title="刷新数据">
          <template #icon><n-icon><ReloadIcon /></n-icon></template>
          刷新
        </n-button>
        <n-button @click="triggerImport" style="flex: 1;">
          <template #icon><n-icon><UploadIcon /></n-icon></template>
          导入
        </n-button>
        <n-dropdown
          :options="exportOptions"
          @select="key => $emit('export', key)"
          trigger="click"
        >
          <n-button style="flex: 1;">
            <template #icon><n-icon><DownloadIcon /></n-icon></template>
            导出
          </n-button>
        </n-dropdown>
      </n-button-group>

      <input
        ref="fileInputRef"
        type="file"
        accept=".csv,.json"
        style="display:none"
        @change="onFileSelected"
      />

      <n-button
        :type="hasUnsaved ? 'warning' : 'primary'"
        block
        @click="$emit('save')"
        style="margin-top: 10px;"
      >
        <template #icon>
          <n-icon><SaveIcon /></n-icon>
        </template>
        {{ hasUnsaved ? '保存编辑器修改（待保存）' : '保存编辑器修改' }}
      </n-button>
    </div>

    <!-- 分区二：筛选 -->
    <div class="filter-section">
      <div class="section-title">
        <span>筛选</span>
      </div>

      <n-input
        :value="searchTerm"
        @update:value="v => $emit('update:searchTerm', v)"
        placeholder="搜索任务名称..."
        clearable
        size="small"
      >
        <template #prefix>
          <n-icon><SearchIcon /></n-icon>
        </template>
      </n-input>

      <div style="margin-top: 12px;">
        <div class="section-title" style="margin-bottom: 8px;">
          <span style="font-size: 11px;">机器人</span>
          <span>
            <a class="section-title-link" @click.prevent="selectAllBots">全选</a>
            <span style="margin: 0 4px; color: rgba(0,0,0,0.15);">/</span>
            <a class="section-title-link" @click.prevent="clearBots">清空</a>
          </span>
        </div>
        <n-checkbox-group
          :value="selectedBots"
          @update:value="v => $emit('update:selectedBots', v)"
        >
          <n-space vertical :size="6">
            <n-checkbox v-for="bot in allBots" :key="bot" :value="bot">
              <span class="bot-checkbox-row">
                <span class="bot-checkbox-row-label">
                  <span class="bot-checkbox-row-dot" :style="{ background: getBotColor(bot) }"></span>
                  {{ bot }}
                </span>
                <span class="bot-checkbox-row-count">{{ botCounts[bot] || 0 }}</span>
              </span>
            </n-checkbox>
          </n-space>
        </n-checkbox-group>
      </div>

      <div style="margin-top: 12px;">
        <div class="section-title" style="margin-bottom: 8px;">
          <span style="font-size: 11px;">排序</span>
        </div>
        <n-radio-group
          :value="sortBy"
          @update:value="v => $emit('update:sortBy', v)"
          size="small"
          style="width: 100%; display: flex;"
        >
          <n-radio-button value="bot" style="flex: 1; text-align: center;">按机器人</n-radio-button>
          <n-radio-button value="time" style="flex: 1; text-align: center;">按时间</n-radio-button>
        </n-radio-group>
      </div>
    </div>

    <!-- 分区三：统计 -->
    <div class="filter-section">
      <div class="section-title">
        <span>统计</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <div class="stat-card stat-card-blue">
          <div class="stat-card-num">{{ filteredCount }}</div>
          <div class="stat-card-label">当前显示</div>
        </div>
        <div class="stat-card stat-card-gray">
          <div class="stat-card-num">{{ totalCount }}</div>
          <div class="stat-card-label">总任务数</div>
        </div>
      </div>
    </div>

    <!-- 新增任务（大按钮收尾） -->
    <n-button type="primary" block size="medium" @click="$emit('create')">
      <template #icon><n-icon><PlusIcon /></n-icon></template>
      新增任务
    </n-button>
  </n-card>
</template>

<script setup>
import { h, ref, computed } from 'vue'
import {
  NCard,
  NSpace,
  NButton,
  NButtonGroup,
  NInput,
  NCheckboxGroup,
  NCheckbox,
  NRadioGroup,
  NRadioButton,
  NIcon,
  NDropdown,
} from 'naive-ui'
import { getBotColor, getHasUnsavedChanges } from '../services/dataService.js'

// 图标组件
const iconStyle = { width: '14px', height: '14px' }
const SearchIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('circle', { cx: '11', cy: '11', r: '8' }),
      h('path', { d: 'm21 21-4.35-4.35' }),
    ]
  )
const ReloadIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('path', { d: 'M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.5 2.8L21 8' }),
      h('path', { d: 'M21 3v5h-5' }),
      h('path', { d: 'M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.5-2.8L3 16' }),
      h('path', { d: 'M3 21v-5h5' }),
    ]
  )
const UploadIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
      h('polyline', { points: '17 8 12 3 7 8' }),
      h('line', { x1: '12', y1: '3', x2: '12', y2: '15' }),
    ]
  )
const DownloadIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
      h('polyline', { points: '7 10 12 15 17 10' }),
      h('line', { x1: '12', y1: '15', x2: '12', y2: '3' }),
    ]
  )
const SaveIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }),
      h('polyline', { points: '17 21 17 13 7 13 7 21' }),
      h('polyline', { points: '7 3 7 8 15 8' }),
    ]
  )
const PlusIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', style: iconStyle },
    [
      h('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
      h('line', { x1: '5', y1: '12', x2: '19', y2: '12' }),
    ]
  )

const props = defineProps({
  searchTerm: { type: String, default: '' },
  selectedBots: { type: Array, default: () => [] },
  sortBy: { type: String, default: 'bot' },
  allBots: { type: Array, default: () => [] },
  allTasks: { type: Array, default: () => [] },
  filteredCount: { type: Number, default: 0 },
  totalCount: { type: Number, default: 0 },
})

const emit = defineEmits([
  'update:searchTerm',
  'update:selectedBots',
  'update:sortBy',
  'refresh',
  'import',
  'export',
  'create',
  'save',
])

const exportOptions = [
  { label: '导出为 CSV', key: 'csv' },
  { label: '导出为 JSON', key: 'json' },
]

// 是否有未保存修改（响应式由父组件 totalCount/filteredCount 变化时重新计算保证刷新）
const hasUnsaved = computed(() => {
  // 借助 props 变化触发；调用 getHasUnsavedChanges 取当前状态
  // eslint-disable-next-line no-unused-expressions
  props.totalCount, props.filteredCount, props.allTasks
  return getHasUnsavedChanges()
})

// 每个机器人任务数（来自 allTasks）
const botCounts = computed(() => {
  const map = {}
  for (const t of props.allTasks) {
    map[t.bot] = (map[t.bot] || 0) + 1
  }
  return map
})

function selectAllBots() {
  emit('update:selectedBots', [...props.allBots])
}
function clearBots() {
  emit('update:selectedBots', [])
}

const fileInputRef = ref(null)
function triggerImport() {
  fileInputRef.value?.click()
}
function onFileSelected(e) {
  const file = e.target.files?.[0]
  if (file) {
    emit('import', file)
    e.target.value = ''
  }
}
</script>

<style scoped>
.filter-panel {
  position: sticky;
  top: 16px;
}

.filter-section {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f5f5f5;
}

.filter-section:last-of-type {
  border-bottom: none;
  padding-bottom: 12px;
}
</style>
