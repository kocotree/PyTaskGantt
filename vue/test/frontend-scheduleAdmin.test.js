// @vitest-environment jsdom

import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pageState = vi.hoisted(() => ({
  auth: { user: { id: '7', display_name: '管理员', is_admin: true }, uiRefreshSeconds: 60 },
  load: vi.fn(async () => []),
  recoverTask: vi.fn(async () => ({ success: true })),
  slotStub: { template: '<div><slot /></div>' },
  task: {
    id: '10',
    task: '历史任务',
    start: '09:00:00',
    finish: '10:00:00',
    bot: '旧机器人',
    tags: [],
    note: '',
    version: 3,
    owner: null,
    schedule_uuid: '',
    can_edit: false,
    is_legacy_unbound: true,
    normalized_status: '待运行',
  },
}))

vi.mock('../src/services/authService.js', () => ({ auth: pageState.auth }))
vi.mock('../src/services/taskService.js', () => ({
  exportTasks: vi.fn(),
  getUsers: vi.fn(async () => [{ id: '8', display_name: '目标用户' }]),
  importTasks: vi.fn(),
  rebindTask: vi.fn(),
  recoverTask: pageState.recoverTask,
  runTask: vi.fn(),
  syncTask: vi.fn(),
  transferTask: vi.fn(),
}))
vi.mock('../src/stores/taskDraftStore.js', () => ({
  scheduleTaskStore: {
    state: { loading: false, saving: false, error: '' },
    tasks: { value: [pageState.task] },
    hasUnsaved: { value: false },
    mutationList: { value: [] },
    load: pageState.load,
    save: vi.fn(),
    addTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    isDirty: vi.fn(() => false),
  },
}))

vi.mock('../src/components/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<main><slot /></main>' },
}))
vi.mock('../src/components/ExecutionHistoryDialog.vue', () => ({
  default: { name: 'ExecutionHistoryDialog', template: '<div />' },
}))
vi.mock('../src/components/FilterPanel.vue', () => ({
  default: { name: 'FilterPanel', template: '<div />' },
}))
vi.mock('../src/components/GanttChart.vue', () => ({
  default: { name: 'GanttChart', template: '<div />' },
}))
vi.mock('../src/components/TaskEditor.vue', () => ({
  default: { name: 'TaskEditor', template: '<div />' },
}))
vi.mock('../src/components/TaskList.vue', () => ({
  default: {
    name: 'TaskList',
    props: ['tasks', 'canRecover'],
    emits: ['recover'],
    template: '<button v-if="canRecover" class="recover-entry" @click="$emit(\'recover\', tasks[0])">分配并绑定</button>',
  },
}))
vi.mock('../src/components/SchedulePicker.vue', () => ({
  default: {
    name: 'SchedulePicker',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<button class="schedule-choice" @click="$emit(\'update:modelValue\', \'schedule-recovered\')">选择计划</button>',
  },
}))

vi.mock('naive-ui', () => ({
  NAlert: pageState.slotStub,
  NButton: {
    props: ['disabled'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NModal: {
    props: ['show'],
    emits: ['update:show'],
    template: '<section v-if="show"><slot /><slot name="footer" /></section>',
  },
  NSelect: {
    props: ['value'],
    emits: ['update:value'],
    template: '<button class="owner-choice" @click="$emit(\'update:value\', \'8\')">选择用户</button>',
  },
  NSpace: pageState.slotStub,
  NSpin: pageState.slotStub,
  NTag: pageState.slotStub,
  useDialog: () => ({ warning: vi.fn() }),
  useMessage: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}))

import SchedulePage from '../src/pages/SchedulePage.vue'

describe('SchedulePage administrator recovery', () => {
  beforeEach(() => {
    pageState.auth.user.is_admin = true
    pageState.recoverTask.mockClear()
    pageState.load.mockClear()
  })

  it('管理员看到恢复入口并提交目标用户、计划和乐观锁版本', async () => {
    const wrapper = mount(SchedulePage)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'TaskList' }).props('canRecover')).toBe(true)

    await wrapper.get('.recover-entry').trigger('click')
    await wrapper.get('.owner-choice').trigger('click')
    await wrapper.get('.schedule-choice').trigger('click')
    await nextTick()
    const confirm = wrapper.findAll('button').find(button => button.text() === '确认分配并绑定')
    expect(confirm.attributes('disabled')).toBeUndefined()
    await confirm.trigger('click')
    await flushPromises()

    expect(pageState.recoverTask).toHaveBeenCalledWith('10', '8', 'schedule-recovered', 3)
    expect(pageState.load).toHaveBeenLastCalledWith({ preserveDraft: true, silent: true })
    wrapper.unmount()
  })

  it('普通用户不显示历史任务恢复入口', async () => {
    pageState.auth.user.is_admin = false
    const wrapper = mount(SchedulePage)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'TaskList' }).props('canRecover')).toBe(false)
    expect(wrapper.find('.recover-entry').exists()).toBe(false)
    wrapper.unmount()
  })
})
