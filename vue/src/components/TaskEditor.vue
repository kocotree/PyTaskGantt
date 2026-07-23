<template>
  <n-modal
    :show="show"
    preset="card"
    :title="modalTitle"
    class="responsive-modal task-editor-modal"
    :mask-closable="false"
    :bordered="false"
    @update:show="value => $emit('update:show', value)"
  >
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="top">
      <n-form-item label="任务名称" path="task">
        <n-input v-model:value="form.task" placeholder="例如：登录系统" maxlength="100" show-count />
      </n-form-item>

      <n-grid cols="1 700:2" :x-gap="16">
        <n-form-item-gi label="机器人 / Bot" path="bot">
          <n-select
            v-model:value="form.bot"
            :options="botOptions"
            placeholder="选择或输入新机器人"
            filterable
            tag
          />
        </n-form-item-gi>
        <n-form-item-gi label="标签">
          <n-select
            v-model:value="form.tags"
            :options="tagOptions"
            placeholder="输入标签后回车"
            filterable
            multiple
            tag
          />
        </n-form-item-gi>
      </n-grid>

      <n-grid cols="1 560:2" :x-gap="16">
        <n-form-item-gi label="开始时间" path="start">
          <n-time-picker v-model:formatted-value="form.start" value-format="HH:mm:ss" format="HH:mm:ss" />
        </n-form-item-gi>
        <n-form-item-gi label="结束时间" path="finish">
          <n-time-picker v-model:formatted-value="form.finish" value-format="HH:mm:ss" format="HH:mm:ss" />
        </n-form-item-gi>
      </n-grid>

      <n-alert v-if="isCrossDayTask" type="info" :show-icon="true" class="editor-alert">
        已识别为跨天任务（实际时长约 {{ durationText }}）
      </n-alert>

      <n-form-item v-if="mode === 'create'" label="绑定影刀计划" path="schedule_uuid">
        <SchedulePicker
          v-model="form.schedule_uuid"
          :selected-name="form.schedule_name"
          :reserved-uuids="reservedScheduleUuids"
          @select="schedule => form.schedule_name = schedule?.schedule_name || ''"
        />
      </n-form-item>
      <n-form-item v-else label="当前影刀计划">
        <div class="current-binding">
          <strong>{{ form.schedule_name || (form.schedule_uuid ? '已绑定计划' : '历史任务待绑定') }}</strong>
          <code>{{ form.schedule_uuid || '未绑定，仅可只读展示' }}</code>
          <small v-if="form.schedule_uuid">如需更换计划，请在“我的任务”页面使用“换绑”。</small>
        </div>
      </n-form-item>

      <n-form-item label="备注">
        <n-input
          v-model:value="form.note"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 7 }"
          maxlength="2000"
          show-count
          placeholder="补充运行说明、交接信息或注意事项"
        />
      </n-form-item>
    </n-form>

    <template #footer>
      <div class="editor-footer">
        <n-button v-if="mode === 'edit'" type="error" ghost @click="confirmDelete">删除任务</n-button>
        <span v-else></span>
        <n-space>
          <n-button @click="$emit('update:show', false)">取消</n-button>
          <n-button type="primary" @click="onSubmit">
            {{ mode === 'create' ? '加入待保存草稿' : '保存到草稿' }}
          </n-button>
        </n-space>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NFormItemGi,
  NGrid,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NTimePicker,
  useDialog,
  useMessage,
} from 'naive-ui'
import SchedulePicker from './SchedulePicker.vue'
import { formatDuration, isCrossDay, normalizeTime } from '../services/dataService.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'create' },
  task: { type: Object, default: () => ({}) },
  allBots: { type: Array, default: () => [] },
  allTags: { type: Array, default: () => [] },
  reservedScheduleUuids: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:show', 'submit', 'delete'])
const message = useMessage()
const dialog = useDialog()
const formRef = ref(null)
const form = reactive({
  id: null,
  version: 0,
  task: '',
  bot: '',
  start: '09:00:00',
  finish: '09:30:00',
  tags: [],
  note: '',
  schedule_uuid: '',
  schedule_name: '',
})

watch(() => [props.show, props.task], () => {
  if (!props.show) return
  Object.assign(form, {
    id: props.task?.id ?? null,
    version: props.task?.version || 0,
    task: props.task?.task || '',
    bot: props.task?.bot || props.allBots[0] || '',
    start: normalizeTime(props.task?.start || '09:00:00'),
    finish: normalizeTime(props.task?.finish || '09:30:00'),
    tags: [...(props.task?.tags || [])],
    note: props.task?.note || '',
    schedule_uuid: props.task?.schedule_uuid || '',
    schedule_name: props.task?.schedule_name || '',
  })
}, { immediate: true, deep: true })

const modalTitle = computed(() => props.mode === 'create' ? '新增任务' : '编辑任务')
const botOptions = computed(() => [...new Set([...props.allBots, form.bot].filter(Boolean))].map(value => ({ label: value, value })))
const tagOptions = computed(() => [...new Set([...props.allTags, ...form.tags])].map(value => ({ label: value, value })))
const isCrossDayTask = computed(() => form.start && form.finish && isCrossDay(form.start, form.finish))
const durationText = computed(() => formatDuration(form.start, form.finish))

const rules = computed(() => ({
  task: [{ required: true, message: '请输入任务名称', trigger: ['blur', 'input'] }],
  bot: [{ required: true, message: '请选择或输入机器人', trigger: ['blur', 'change'] }],
  start: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  finish: [{ required: true, message: '请选择结束时间', trigger: 'change' }],
  schedule_uuid: props.mode === 'create'
    ? [{ required: true, message: '新任务必须绑定影刀计划', trigger: 'change' }]
    : [],
}))

async function onSubmit() {
  try {
    await formRef.value?.validate()
    const payload = {
      id: form.id,
      version: form.version,
      task: form.task,
      bot: form.bot,
      tags: [...new Set(form.tags.map(tag => tag.trim()).filter(Boolean))],
      start: normalizeTime(form.start),
      finish: normalizeTime(form.finish),
      note: form.note,
    }
    if (props.mode === 'create') {
      payload.schedule_uuid = form.schedule_uuid
      payload.schedule_name = form.schedule_name
    }
    emit('submit', payload)
  } catch {
    message.warning('请完善表单信息')
  }
}

function confirmDelete() {
  dialog.warning({
    title: '确认删除',
    content: `删除任务“${form.task}”将在下次点击保存时生效。`,
    positiveText: '加入删除草稿',
    negativeText: '取消',
    onPositiveClick: () => emit('delete', form.id),
  })
}
</script>
