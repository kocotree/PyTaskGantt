// @vitest-environment jsdom

import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dialogState = vi.hoisted(() => ({
  getTaskExecutions: vi.fn(),
  getExecutionJobs: vi.fn(),
  getJobLogs: vi.fn(),
  messageError: vi.fn(),
}))

vi.mock('../src/services/taskService.js', () => ({
  getTaskExecutions: (...args) => dialogState.getTaskExecutions(...args),
}))

vi.mock('../src/services/yingdaoService.js', () => ({
  getExecutionJobs: (...args) => dialogState.getExecutionJobs(...args),
  getJobLogs: (...args) => dialogState.getJobLogs(...args),
}))

vi.mock('naive-ui', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    useMessage: () => ({ error: dialogState.messageError }),
  }
})

import ExecutionHistoryDialog from '../src/components/ExecutionHistoryDialog.vue'

const ModalStub = defineComponent({
  props: { show: Boolean, title: String },
  emits: ['update:show'],
  template: '<section v-if="show" class="modal-stub"><h2>{{ title }}</h2><slot /></section>',
})
const SpinStub = defineComponent({
  props: { show: Boolean },
  template: '<div class="spin-stub" :aria-busy="show"><slot /></div>',
})
const EmptyStub = defineComponent({
  props: { description: String },
  template: '<div class="empty-stub">{{ description }}</div>',
})
const ButtonStub = defineComponent({
  props: { loading: Boolean, disabled: Boolean },
  emits: ['click'],
  template: '<button type="button" :disabled="disabled" :aria-busy="loading" @click="$emit(\'click\')"><slot /></button>',
})
const TagStub = defineComponent({ template: '<span class="tag-stub"><slot /></span>' })

function mountDialog(task = { id: '38', task: '每日拼多多统计' }) {
  return mount(ExecutionHistoryDialog, {
    props: { show: true, task },
    global: {
      stubs: {
        NButton: ButtonStub,
        NEmpty: EmptyStub,
        NModal: ModalStub,
        NSpin: SpinStub,
        NTag: TagStub,
      },
    },
  })
}

function findButton(label, index = 0) {
  return [...document.body.querySelectorAll('button')]
    .filter(button => button.textContent.includes(label))[index]
}

describe('ExecutionHistoryDialog', () => {
  beforeEach(() => {
    dialogState.getTaskExecutions.mockReset()
    dialogState.getExecutionJobs.mockReset()
    dialogState.getJobLogs.mockReset()
    dialogState.messageError.mockReset()
  })

  it('分页追加执行历史、应用明细和日志，并标明过期缓存', async () => {
    dialogState.getTaskExecutions
      .mockResolvedValueOnce({
        executions: [
          { task_uuid: 'execution-1', normalized_status: '运行成功', trigger_time: '2026-07-23T01:00:00Z' },
          { task_uuid: 'execution-2', normalized_status: '运行失败', trigger_time: '2026-07-23T02:00:00Z' },
        ],
        pagination: { limit: 20, offset: 0, total: 3, has_more: true },
      })
      .mockResolvedValueOnce({
        executions: [
          { task_uuid: 'execution-2', normalized_status: '运行失败', trigger_time: '2026-07-23T02:00:00Z' },
          { task_uuid: 'execution-3', normalized_status: '运行中', trigger_time: '2026-07-23T03:00:00Z' },
        ],
        pagination: { limit: 20, offset: 2, total: 3, has_more: false },
      })
    dialogState.getExecutionJobs.mockResolvedValueOnce([{
      job_uuid: 'job-1',
      robot_name: '店铺销售机器人',
      status_name: '运行成功',
    }])
    dialogState.getJobLogs
      .mockResolvedValueOnce({
        logs: [{ time: '09:00:01', level: 'INFO', message: '第一页日志' }],
        pagination: { page: 1, size: 50, total: 2, has_more: true },
        cached: true,
        stale: true,
        cache_age_seconds: 88,
      })
      .mockResolvedValueOnce({
        logs: [{ time: '09:00:02', level: 'INFO', message: '第二页日志' }],
        pagination: { page: 2, size: 50, total: 2, has_more: false },
        cached: false,
        stale: false,
        cache_age_seconds: 0,
      })

    const wrapper = mountDialog()
    await flushPromises()

    expect(dialogState.getTaskExecutions).toHaveBeenNthCalledWith(1, '38', { limit: 20, offset: 0 })
    expect(document.body.querySelectorAll('.execution-card')).toHaveLength(2)

    findButton('加载更多执行记录').click()
    await flushPromises()

    expect(dialogState.getTaskExecutions).toHaveBeenNthCalledWith(2, '38', { limit: 20, offset: 2 })
    expect(document.body.querySelectorAll('.execution-card')).toHaveLength(3)

    findButton('应用明细与日志').click()
    await flushPromises()

    expect(dialogState.getExecutionJobs).toHaveBeenCalledWith('execution-1')
    expect(document.body.textContent).toContain('店铺销售机器人')

    findButton('运行日志').click()
    await flushPromises()

    expect(dialogState.getJobLogs).toHaveBeenNthCalledWith(1, 'job-1', { page: 1, size: 50 })
    expect(document.body.textContent).toContain('第一页日志')
    expect(document.body.textContent).toContain('日志接口暂不可用，当前显示 88 秒前的缓存')

    findButton('加载更多日志').click()
    await flushPromises()

    expect(dialogState.getJobLogs).toHaveBeenNthCalledWith(2, 'job-1', { page: 2, size: 50 })
    expect(document.body.textContent).toContain('第一页日志')
    expect(document.body.textContent).toContain('第二页日志')
    expect(findButton('加载更多日志')).toBeUndefined()
    wrapper.unmount()
  })

  it('分别提示历史、应用和日志加载错误，并允许切换任务或重试', async () => {
    dialogState.getTaskExecutions
      .mockRejectedValueOnce(new Error('历史服务不可用'))
      .mockResolvedValueOnce({
        executions: [{ task_uuid: 'execution-retry', normalized_status: '运行中' }],
        pagination: { limit: 20, offset: 0, total: 1, has_more: false },
      })
    dialogState.getExecutionJobs
      .mockRejectedValueOnce(new Error('应用服务不可用'))
      .mockResolvedValueOnce([{ job_uuid: 'job-retry', robot_name: '重试机器人' }])
    dialogState.getJobLogs
      .mockRejectedValueOnce(new Error('日志服务不可用'))
      .mockResolvedValueOnce({
        logs: ['重试后的日志'],
        pagination: { page: 1, size: 50, total: 1, has_more: false },
        cached: true,
        stale: false,
        cache_age_seconds: 5,
      })

    const wrapper = mountDialog()
    await flushPromises()

    expect(dialogState.messageError).toHaveBeenCalledWith('执行记录加载失败：历史服务不可用')

    await wrapper.setProps({ task: { id: '39', task: '重试任务' } })
    await flushPromises()
    expect(dialogState.getTaskExecutions).toHaveBeenLastCalledWith('39', { limit: 20, offset: 0 })

    findButton('应用明细与日志').click()
    await flushPromises()
    expect(dialogState.messageError).toHaveBeenCalledWith('应用明细加载失败：应用服务不可用')

    findButton('应用明细与日志').click()
    await flushPromises()
    expect(document.body.textContent).toContain('重试机器人')

    findButton('运行日志').click()
    await flushPromises()
    expect(dialogState.messageError).toHaveBeenCalledWith('运行日志加载失败：日志服务不可用')

    findButton('运行日志').click()
    await flushPromises()
    expect(document.body.textContent).toContain('重试后的日志')
    expect(document.body.textContent).toContain('日志来自 5 秒前的有效缓存')
    wrapper.unmount()
  })
})
