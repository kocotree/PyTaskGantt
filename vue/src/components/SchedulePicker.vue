<template>
  <div class="schedule-picker-field">
    <n-input-group>
      <n-input
        :value="displayValue"
        readonly
        :disabled="disabled"
        :placeholder="placeholder"
        @click="openPicker"
      />
      <n-button :disabled="disabled" @click="openPicker">选择计划</n-button>
      <n-button v-if="clearable && modelValue" :disabled="disabled" @click="clearSelection">清除</n-button>
    </n-input-group>
    <div v-if="modelValue" class="schedule-picker-uuid mono">{{ modelValue }}</div>

    <n-modal
      v-model:show="show"
      preset="card"
      title="选择影刀计划"
      class="responsive-modal schedule-picker-modal"
      :mask-closable="false"
    >
      <n-input
        v-model:value="query"
        clearable
        placeholder="按计划名称或 scheduleUuid 搜索"
        @update:value="scheduleSearch"
      />

      <n-alert v-if="loadError" type="error" :show-icon="true" class="picker-cache-alert">
        计划列表加载失败，未使用旧结果：{{ loadError }}
      </n-alert>
      <n-alert v-else-if="result.stale" type="warning" :show-icon="true" class="picker-cache-alert">
        影刀接口暂不可用，当前使用 {{ result.cache_age_seconds }} 秒前的可信缓存。
      </n-alert>
      <n-alert v-else-if="result.cached" type="info" :show-icon="true" class="picker-cache-alert">
        当前计划列表来自 {{ result.cache_age_seconds }} 秒前的有效缓存。
      </n-alert>

      <div class="schedule-result-list" :aria-busy="loading">
        <n-spin v-if="loading" size="small" />
        <n-empty v-else-if="!result.schedules.length" description="没有找到可选计划" />
        <button
          v-for="schedule in result.schedules"
          v-else
          :key="schedule.schedule_uuid"
          type="button"
          class="schedule-option"
          :class="{ 'schedule-option-bound': isUnavailable(schedule) }"
          :disabled="isUnavailable(schedule)"
          @click="choose(schedule)"
        >
          <span>
            <strong>{{ schedule.schedule_name || '未命名计划' }}</strong>
            <small class="mono">{{ schedule.schedule_uuid }}</small>
          </span>
          <span v-if="schedule.bound" class="schedule-option-owner">
            已绑定：{{ schedule.bound_task_name || schedule.bound_task_id || '其他任务' }}
            <template v-if="schedule.bound_owner"> · {{ schedule.bound_owner.display_name || schedule.bound_owner }}</template>
          </span>
          <span v-else-if="reservedSet.has(schedule.schedule_uuid)" class="schedule-option-owner">已被当前草稿占用</span>
          <n-tag v-else size="small" type="success" :bordered="false">可绑定</n-tag>
        </button>
      </div>

      <div class="schedule-pagination">
        <n-pagination
          v-model:page="page"
          :page-size="result.size || pageSize"
          :item-count="result.total"
          simple
          @update:page="load"
        />
      </div>
    </n-modal>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NInputGroup,
  NModal,
  NPagination,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui'
import { getSchedules } from '../services/yingdaoService.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  selectedName: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: false },
  includeBound: { type: Boolean, default: false },
  reservedUuids: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择唯一的影刀计划' },
})

const emit = defineEmits(['update:modelValue', 'select'])
const message = useMessage()
const show = ref(false)
const query = ref('')
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const loadError = ref('')
const selected = ref(null)
const result = reactive({ schedules: [], page: 1, size: pageSize, total: 0, cached: false, stale: false, cache_age_seconds: 0 })
const reservedSet = computed(() => new Set(props.reservedUuids.filter(uuid => uuid !== props.modelValue)))
const displayValue = computed(() => selected.value?.schedule_name || props.selectedName || props.modelValue)
let searchTimer = null
let requestId = 0

watch(() => props.modelValue, value => {
  if (!value || (selected.value && selected.value.schedule_uuid !== value)) selected.value = null
})

watch(show, visible => {
  if (visible) return
  clearTimeout(searchTimer)
  requestId += 1
  loading.value = false
})

async function load() {
  const currentRequest = ++requestId
  loading.value = true
  loadError.value = ''
  try {
    const data = await getSchedules({
      query: query.value.trim(),
      page: page.value,
      size: pageSize,
      include_bound: props.includeBound,
    })
    if (currentRequest !== requestId) return
    Object.assign(result, data)
  } catch (error) {
    if (currentRequest === requestId) {
      Object.assign(result, {
        schedules: [],
        page: page.value,
        size: pageSize,
        total: 0,
        cached: false,
        stale: false,
        cache_age_seconds: 0,
      })
      loadError.value = error.message || '影刀接口不可用'
      message.error(`计划加载失败：${loadError.value}`)
    }
  } finally {
    if (currentRequest === requestId) loading.value = false
  }
}

function openPicker() {
  if (props.disabled) return
  show.value = true
  page.value = 1
  load()
}

function scheduleSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    load()
  }, 250)
}

function isUnavailable(schedule) {
  return (schedule.bound && schedule.schedule_uuid !== props.modelValue) || reservedSet.value.has(schedule.schedule_uuid)
}

function choose(schedule) {
  if (isUnavailable(schedule)) return
  selected.value = schedule
  emit('update:modelValue', schedule.schedule_uuid)
  emit('select', schedule)
  show.value = false
}

function clearSelection() {
  selected.value = null
  emit('update:modelValue', '')
  emit('select', null)
}

onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  requestId += 1
})
</script>
