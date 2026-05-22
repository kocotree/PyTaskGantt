<template>
  <n-modal
    :show="show"
    preset="card"
    :title="modalTitle"
    :style="{ width: '560px' }"
    :mask-closable="false"
    :bordered="false"
    size="medium"
    @update:show="v => $emit('update:show', v)"
  >
    <n-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-placement="top"
      :show-require-mark="true"
    >
      <n-form-item label="任务名称" path="task">
        <n-input
          v-model:value="form.task"
          placeholder="例如：登录系统"
          maxlength="100"
          show-count
        />
      </n-form-item>

      <n-form-item label="机器人" path="bot">
        <n-select
          v-model:value="form.bot"
          :options="botOptions"
          placeholder="选择或输入新机器人"
          filterable
          tag
        />
      </n-form-item>

      <n-grid :cols="2" :x-gap="16">
        <n-form-item-gi label="开始时间" path="start">
          <n-time-picker
            v-model:formatted-value="form.start"
            value-format="HH:mm:ss"
            format="HH:mm:ss"
            style="width: 100%;"
          />
        </n-form-item-gi>
        <n-form-item-gi label="结束时间" path="finish">
          <n-time-picker
            v-model:formatted-value="form.finish"
            value-format="HH:mm:ss"
            format="HH:mm:ss"
            style="width: 100%;"
          />
        </n-form-item-gi>
      </n-grid>

      <n-alert
        v-if="isCrossDayTask"
        type="info"
        :show-icon="true"
        style="margin-top: 8px;"
      >
        已识别为跨天任务（实际时长约 {{ durationText }}）
      </n-alert>
    </n-form>

    <template #footer>
      <div class="editor-footer">
        <div>
          <n-popconfirm
            v-if="mode === 'edit'"
            @positive-click="onDelete"
            negative-text="取消"
            positive-text="删除"
          >
            <template #trigger>
              <n-button type="error" ghost>
                删除任务
              </n-button>
            </template>
            确定要删除任务「{{ form.task }}」吗？
          </n-popconfirm>
        </div>
        <n-space>
          <n-button @click="$emit('update:show', false)">取消</n-button>
          <n-button type="primary" @click="onSubmit">
            {{ mode === 'create' ? '添加任务' : '保存修改' }}
          </n-button>
        </n-space>
      </div>
    </template>
  </n-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import {
  NModal,
  NForm,
  NFormItem,
  NFormItemGi,
  NGrid,
  NInput,
  NSelect,
  NTimePicker,
  NButton,
  NSpace,
  NAlert,
  NPopconfirm,
  useMessage,
} from 'naive-ui'
import { isCrossDay, formatDuration } from '../services/dataService.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  mode: { type: String, default: 'create' }, // 'create' | 'edit'
  task: { type: Object, default: () => ({}) },
  allBots: { type: Array, default: () => [] },
})

const emit = defineEmits(['update:show', 'submit', 'delete'])

const message = useMessage()
const formRef = ref(null)

const form = ref({
  id: null,
  task: '',
  bot: '',
  start: '09:00:00',
  finish: '09:30:00',
})

// 监听 props.task 变化，同步到 form
watch(
  () => props.task,
  newTask => {
    if (newTask) {
      form.value = {
        id: newTask.id ?? null,
        task: newTask.task ?? '',
        bot: newTask.bot ?? '',
        start: newTask.start ?? '09:00:00',
        finish: newTask.finish ?? '09:30:00',
      }
    }
  },
  { immediate: true, deep: true }
)

const modalTitle = computed(() =>
  props.mode === 'create' ? '新增任务' : '编辑任务'
)

const botOptions = computed(() => {
  const opts = props.allBots.map(b => ({ label: b, value: b }))
  // 当前任务的机器人若不在列表中，补一项（编辑历史数据兼容）
  if (form.value.bot && !props.allBots.includes(form.value.bot)) {
    opts.unshift({ label: form.value.bot, value: form.value.bot })
  }
  return opts
})

const rules = {
  task: [
    { required: true, message: '请输入任务名称', trigger: ['blur', 'input'] },
  ],
  bot: [
    { required: true, message: '请选择或输入机器人', trigger: ['blur', 'change'] },
  ],
  start: [{ required: true, message: '请选择开始时间', trigger: 'change' }],
  finish: [{ required: true, message: '请选择结束时间', trigger: 'change' }],
}

const isCrossDayTask = computed(() => {
  if (!form.value.start || !form.value.finish) return false
  return isCrossDay(form.value.start, form.value.finish)
})

const durationText = computed(() => {
  if (!form.value.start || !form.value.finish) return ''
  return formatDuration(form.value.start, form.value.finish)
})

function onSubmit() {
  formRef.value?.validate(errors => {
    if (errors) {
      message.warning('请完善表单信息')
      return
    }
    emit('submit', { ...form.value })
  })
}

function onDelete() {
  if (form.value.id != null) {
    emit('delete', form.value.id)
  }
}
</script>

<style scoped>
.editor-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 4px;
}
</style>

<style>
/* 全局：编辑器内删除按钮 hover 红色微阴影 */
.n-modal .n-button--error-type.n-button--ghost:hover {
  box-shadow: 0 1px 3px rgba(255, 77, 79, 0.2);
}
</style>
