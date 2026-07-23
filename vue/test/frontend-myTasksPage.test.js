// @vitest-environment jsdom

import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const pageState = vi.hoisted(() => ({
  load: vi.fn(async () => []),
  slotStub: { template: '<div><slot name="header-extra"/><slot/></div>' },
  selectStub: {
    name: 'NSelect',
    props: {
      value: { type: [Array, String, Number], default: null },
      options: { type: Array, default: () => [] },
      placeholder: { type: String, default: '' },
    },
    emits: ['update:value'],
    template: '<div class="select-stub" :data-placeholder="placeholder" />',
  },
  dataTableStub: {
    name: 'NDataTable',
    props: { data: { type: Array, default: () => [] } },
    template: '<ol class="data-table-stub"><li v-for="row in data" :key="row.id" class="task-row">{{ row.task }}</li></ol>',
  },
  tasks: [
    {
      id: '1',
      task: '双标签日报',
      start: '09:00:00',
      finish: '09:30:00',
      bot: '财务机器人',
      tags: ['财务', '日报'],
      note: '',
      schedule_uuid: 'schedule-1',
      normalized_status: '运行成功',
      last_synced_at: '2026-07-22T04:00:00.000Z',
      updated_at: '2026-07-22T04:00:00.000Z',
      sync_error: '影刀接口超时',
      can_edit: true,
      version: 1,
    },
    {
      id: '2',
      task: '仅财务标签',
      start: '10:00:00',
      finish: '10:30:00',
      bot: '财务机器人',
      tags: ['财务'],
      note: '',
      schedule_uuid: 'schedule-2',
      normalized_status: '待运行',
      last_synced_at: '2026-07-22T05:00:00.000Z',
      updated_at: '2026-07-22T05:00:00.000Z',
      sync_error: '',
      can_edit: true,
      version: 1,
    },
    {
      id: '3',
      task: '仅日报标签',
      start: '11:00:00',
      finish: '11:30:00',
      bot: '报表机器人',
      tags: ['日报'],
      note: '',
      schedule_uuid: 'schedule-3',
      normalized_status: '运行中',
      last_synced_at: null,
      updated_at: '2026-07-22T06:00:00.000Z',
      sync_error: '',
      can_edit: true,
      version: 1,
    },
  ],
}))

vi.mock('../src/stores/taskDraftStore.js', () => ({
  myTaskStore: {
    state: { loading: false, saving: false, error: '' },
    tasks: { value: pageState.tasks },
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

vi.mock('../src/services/authService.js', () => ({
  auth: { user: { id: '1', display_name: '苕尖' }, uiRefreshSeconds: 60 },
}))

vi.mock('../src/services/taskService.js', () => ({
  getUsers: vi.fn(async () => []),
  rebindTask: vi.fn(),
  runTask: vi.fn(),
  syncMyTasks: vi.fn(),
  syncTask: vi.fn(),
  transferTask: vi.fn(),
}))

vi.mock('../src/components/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<main><slot /></main>' },
}))
vi.mock('../src/components/ExecutionHistoryDialog.vue', () => ({
  default: { name: 'ExecutionHistoryDialog', template: '<div />' },
}))
vi.mock('../src/components/SchedulePicker.vue', () => ({
  default: { name: 'SchedulePicker', template: '<div />' },
}))
vi.mock('../src/components/TaskEditor.vue', () => ({
  default: { name: 'TaskEditor', template: '<div />' },
}))

vi.mock('naive-ui', () => ({
  NAlert: pageState.slotStub,
  NButton: pageState.slotStub,
  NCard: pageState.slotStub,
  NDataTable: pageState.dataTableStub,
  NDropdown: pageState.slotStub,
  NEmpty: pageState.slotStub,
  NInput: pageState.slotStub,
  NModal: pageState.slotStub,
  NSelect: pageState.selectStub,
  NSpace: pageState.slotStub,
  NSpin: pageState.slotStub,
  NTag: pageState.slotStub,
  useDialog: () => ({ warning: vi.fn() }),
  useMessage: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}))

import MyTasksPage from '../src/pages/MyTasksPage.vue'
import { formatDateTime } from '../src/services/dataService.js'

describe('MyTasksPage filters and sync freshness', () => {
  it('多标签筛选只返回一次匹配任务，并显示保守的数据截至时间和同步错误', async () => {
    const wrapper = mount(MyTasksPage)
    await flushPromises()

    expect(pageState.load).toHaveBeenCalledWith({ preserveDraft: true })
    expect(wrapper.text()).toContain('1 个任务最近同步失败；已保留上次有效状态。最新错误：影刀接口超时')
    expect(wrapper.text()).toContain(
      `影刀数据截至 ${formatDateTime('2026-07-22T04:00:00.000Z')}（部分任务尚未同步）`,
    )

    const tagSelect = wrapper.findAllComponents(pageState.selectStub)
      .find(select => select.props('placeholder') === '标签')
    expect(tagSelect).toBeTruthy()
    expect(tagSelect.props('options').filter(option => option.value === '财务')).toHaveLength(1)
    expect(tagSelect.props('options').filter(option => option.value === '日报')).toHaveLength(1)

    tagSelect.vm.$emit('update:value', ['财务', '日报'])
    await nextTick()

    expect(wrapper.findAll('.task-row').map(row => row.text())).toEqual(['双标签日报'])
    wrapper.unmount()
  })
})
