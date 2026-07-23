// @vitest-environment jsdom

import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pickerState = vi.hoisted(() => ({
  load: async () => ({ schedules: [], page: 1, size: 20, total: 0 }),
  messageError: vi.fn(),
}))

vi.mock('../src/services/yingdaoService.js', () => ({
  getSchedules: (...args) => pickerState.load(...args),
}))

vi.mock('naive-ui', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    useMessage: () => ({ error: pickerState.messageError }),
  }
})

import SchedulePicker from '../src/components/SchedulePicker.vue'

const SlotStub = defineComponent({ template: '<div><slot/></div>' })
const ButtonStub = defineComponent({
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')"><slot/></button>',
})

describe('SchedulePicker trusted results', () => {
  beforeEach(() => {
    pickerState.messageError.mockClear()
  })

  it('硬失败时清空旧计划并明确说明没有使用旧结果', async () => {
    pickerState.load = vi.fn(async () => ({
      schedules: [{
        schedule_uuid: 'schedule-1',
        schedule_name: '日报计划',
        bound: false,
      }],
      page: 1,
      size: 20,
      total: 1,
      cached: false,
      stale: false,
      cache_age_seconds: 0,
    }))
    const wrapper = mount(SchedulePicker, {
      global: {
        stubs: {
          NAlert: SlotStub,
          NButton: ButtonStub,
          NEmpty: SlotStub,
          NInput: SlotStub,
          NInputGroup: SlotStub,
          NModal: SlotStub,
          NPagination: SlotStub,
          NSpin: SlotStub,
          NTag: SlotStub,
        },
      },
    })

    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(pickerState.load).toHaveBeenCalledOnce()
    expect(document.body.querySelectorAll('.schedule-option')).toHaveLength(1)

    pickerState.load = async () => { throw new Error('upstream unavailable') }
    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(document.body.querySelectorAll('.schedule-option')).toHaveLength(0)
    expect(document.body.textContent).toContain('计划列表加载失败，未使用旧结果：upstream unavailable')
    expect(pickerState.messageError).toHaveBeenCalledWith('计划加载失败：upstream unavailable')
    wrapper.unmount()
  })

  it('显示过期缓存，并禁用已绑定计划和当前草稿占用计划', async () => {
    pickerState.load = vi.fn(async () => ({
      schedules: [
        {
          schedule_uuid: 'bound-plan',
          schedule_name: '已绑定计划',
          bound: true,
          bound_task_name: '他人日报',
          bound_owner: { display_name: '李四' },
        },
        { schedule_uuid: 'draft-plan', schedule_name: '草稿占用计划', bound: false },
        { schedule_uuid: 'free-plan', schedule_name: '可选计划', bound: false },
      ],
      page: 1,
      size: 20,
      total: 3,
      cached: true,
      stale: true,
      cache_age_seconds: 66,
    }))
    const wrapper = mount(SchedulePicker, {
      props: {
        includeBound: true,
        reservedUuids: ['draft-plan'],
      },
      global: {
        stubs: {
          NAlert: SlotStub,
          NButton: ButtonStub,
          NEmpty: SlotStub,
          NInput: SlotStub,
          NInputGroup: SlotStub,
          NModal: SlotStub,
          NPagination: SlotStub,
          NSpin: SlotStub,
          NTag: SlotStub,
        },
      },
    })

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(pickerState.load).toHaveBeenCalledWith({
      query: '',
      page: 1,
      size: 20,
      include_bound: true,
    })
    expect(document.body.textContent).toContain('影刀接口暂不可用，当前使用 66 秒前的可信缓存')
    expect(document.body.textContent).toContain('已绑定：他人日报')
    expect(document.body.textContent).toContain('李四')
    expect(document.body.textContent).toContain('已被当前草稿占用')

    const options = [...document.body.querySelectorAll('.schedule-option')]
    expect(options).toHaveLength(3)
    expect(options[0].disabled).toBe(true)
    expect(options[1].disabled).toBe(true)
    expect(options[2].disabled).toBe(false)

    options[2].click()
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toEqual([['free-plan']])
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ schedule_uuid: 'free-plan' })
    wrapper.unmount()
  })
})
