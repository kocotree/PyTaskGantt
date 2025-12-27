<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay" @click.self="handleClose">
        <div class="modal-container glass-panel">
          <div class="modal-header">
            <h3>{{ isEdit ? "编辑任务" : "添加新任务" }}</h3>
            <button class="close-btn" @click="handleClose">
              <component :is="XIcon" />
            </button>
          </div>

          <form @submit.prevent="handleSubmit" class="modal-body">
            <!-- 任务名称 -->
            <div class="form-group">
              <label for="task-name">
                <component :is="ClipboardListIcon" class="label-icon" />
                任务名称
              </label>
              <input
                id="task-name"
                type="text"
                v-model="form.task"
                placeholder="请输入任务名称..."
                required
                class="form-input"
              />
            </div>

            <!-- 机器人选择 -->
            <div class="form-group">
              <label for="bot-select">
                <component :is="BotIcon" class="label-icon" />
                执行机器人
              </label>
              <select
                id="bot-select"
                v-model="form.bot"
                required
                class="form-select"
              >
                <option value="" disabled>请选择机器人</option>
                <option v-for="bot in bots" :key="bot" :value="bot">
                  {{ bot }}
                </option>
              </select>
            </div>

            <!-- 时间范围 -->
            <div class="form-row">
              <div class="form-group">
                <label for="start-time">
                  <component :is="ClockIcon" class="label-icon" />
                  开始时间
                </label>
                <input
                  id="start-time"
                  type="time"
                  v-model="form.start"
                  required
                  class="form-input"
                  step="1"
                />
              </div>

              <div class="form-group">
                <label for="end-time">
                  <component :is="ClockIcon" class="label-icon" />
                  结束时间
                </label>
                <input
                  id="end-time"
                  type="time"
                  v-model="form.finish"
                  required
                  class="form-input"
                  step="1"
                />
              </div>
            </div>

            <!-- 错误提示 -->
            <div v-if="error" class="error-message">
              <component :is="AlertCircleIcon" />
              {{ error }}
            </div>

            <!-- 操作按钮 -->
            <div class="modal-actions">
              <button
                v-if="isEdit"
                type="button"
                class="btn btn-danger"
                @click="handleDelete"
              >
                <component :is="TrashIcon" class="btn-icon" />
                删除
              </button>
              <div class="spacer"></div>
              <button
                type="button"
                class="btn btn-secondary"
                @click="handleClose"
              >
                取消
              </button>
              <button type="submit" class="btn btn-primary">
                <component :is="SaveIcon" class="btn-icon" />
                {{ isEdit ? "保存" : "添加" }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, reactive, watch, computed } from "vue";
import {
  X as XIcon,
  ClipboardList as ClipboardListIcon,
  Bot as BotIcon,
  Clock as ClockIcon,
  AlertCircle as AlertCircleIcon,
  Save as SaveIcon,
  Trash2 as TrashIcon,
} from "lucide-vue-next";

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  task: {
    type: Object,
    default: null,
  },
  bots: {
    type: Array,
    required: true,
  },
});

const emit = defineEmits(["close", "save", "delete"]);

const isEdit = computed(() => !!props.task);

const form = reactive({
  task: "",
  bot: "",
  start: "",
  finish: "",
});

const error = ref("");

// 重置表单 - 必须在 watch 之前定义
const resetForm = () => {
  form.task = "";
  form.bot = "";
  form.start = "";
  form.finish = "";
  error.value = "";
};

// 监听 task prop 变化
watch(
  () => props.task,
  (task) => {
    if (task) {
      form.task = task.task;
      form.bot = task.bot;
      form.start = task.start.substring(0, 5);
      form.finish = task.finish.substring(0, 5);
    } else {
      resetForm();
    }
  },
  { immediate: true }
);

// 关闭弹窗
const handleClose = () => {
  resetForm();
  emit("close");
};

// 验证表单
const validateForm = () => {
  if (!form.task.trim()) {
    error.value = "请输入任务名称";
    return false;
  }
  if (!form.bot) {
    error.value = "请选择执行机器人";
    return false;
  }
  if (!form.start || !form.finish) {
    error.value = "请设置开始和结束时间";
    return false;
  }

  // 比较时间
  const startParts = form.start.split(":").map(Number);
  const finishParts = form.finish.split(":").map(Number);
  const startMinutes = startParts[0] * 60 + startParts[1];
  const finishMinutes = finishParts[0] * 60 + finishParts[1];

  if (finishMinutes <= startMinutes) {
    error.value = "结束时间必须晚于开始时间";
    return false;
  }

  error.value = "";
  return true;
};

// 提交表单
const handleSubmit = () => {
  if (!validateForm()) return;

  const taskData = {
    task: form.task.trim(),
    bot: form.bot,
    start: form.start + ":00",
    finish: form.finish + ":00",
  };

  if (isEdit.value) {
    taskData.id = props.task.id;
  }

  emit("save", taskData);
  handleClose();
};

// 删除任务
const handleDelete = () => {
  if (confirm("确定要删除这个任务吗？")) {
    emit("delete", props.task.id);
    handleClose();
  }
};
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-container {
  width: 90%;
  max-width: 480px;
  max-height: 90vh;
  overflow-y: auto;
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.modal-header h3 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.close-btn svg {
  width: 20px;
  height: 20px;
}

.modal-body {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-group label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.label-icon {
  width: 16px;
  height: 16px;
}

.form-input,
.form-select {
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  transition: all 0.2s ease;
}

.form-input:focus,
.form-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.form-input::placeholder {
  color: var(--text-muted);
}

.form-select {
  cursor: pointer;
}

.form-select option {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.error-message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  color: #ef4444;
  font-size: 0.875rem;
}

.error-message svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.modal-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.spacer {
  flex: 1;
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 18px;
  border: none;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.btn-primary {
  background: linear-gradient(135deg, var(--accent), #a855f7);
  color: white;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--accent-glow);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.1);
}

.btn-danger {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.btn-danger:hover {
  background: rgba(239, 68, 68, 0.2);
}

/* Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.3s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  transform: translateY(20px) scale(0.95);
}
</style>
