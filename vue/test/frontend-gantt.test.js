// @vitest-environment jsdom

import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const timelineState = vi.hoisted(() => ({ instances: [] }))

vi.mock('vis-data', () => {
  class DataSet {
    constructor(rows = []) {
      this.rows = new Map(rows.map(row => [row.id, { ...row }]))
    }

    get(id) {
      return this.rows.get(id)
    }

    getIds() {
      return [...this.rows.keys()]
    }

    update(rows) {
      const values = Array.isArray(rows) ? rows : [rows]
      for (const row of values) {
        this.rows.set(row.id, { ...(this.rows.get(row.id) || {}), ...row })
      }
    }

    remove(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) this.rows.delete(id)
    }
  }

  return { DataSet }
})

vi.mock('vis-timeline/standalone', () => ({
  Timeline: class Timeline {
    constructor(container, items, groups, options) {
      this.container = container
      this.items = items
      this.groups = groups
      this.options = options
      this.handlers = {}
      timelineState.instances.push(this)
    }

    on(event, handler) {
      this.handlers[event] = handler
    }

    destroy() {}
    fit() {}
    setWindow() {}
    getWindow() {
      return {
        start: new Date('2025-01-01T08:30:00'),
        end: new Date('2025-01-01T13:00:00'),
      }
    }
  },
}))

import GanttChart from '../src/components/GanttChart.vue'

function task(overrides = {}) {
  return {
    id: '1',
    task: '每日对账',
    start: '09:00:00',
    finish: '09:30:00',
    bot: '财务机器人',
    owner: { id: '1', display_name: '用户甲' },
    can_edit: true,
    ...overrides,
  }
}

describe('GanttChart ownership boundary', () => {
  beforeEach(() => {
    timelineState.instances.length = 0
  })

  it('只允许 can_edit 任务拖拽，并将自己的新时间作为 mutation 事件上报', async () => {
    const editable = task()
    const locked = task({
      id: '2',
      task: '他人任务',
      owner: { id: '2', display_name: '用户乙' },
      can_edit: false,
    })
    const wrapper = mount(GanttChart, {
      props: { tasks: [editable, locked] },
      global: {
        stubs: {
          NCard: { template: '<section><slot name="header"/><slot/><slot name="header-extra"/></section>' },
          NSpace: { template: '<div><slot/></div>' },
          NButton: { template: '<button><slot/></button>' },
          NEmpty: { template: '<div />' },
          teleport: true,
        },
      },
    })
    await nextTick()

    const timeline = timelineState.instances.at(-1)
    expect(timeline).toBeTruthy()
    expect(timeline.items.get('1').editable).toMatchObject({ updateTime: true, updateGroup: false })
    expect(timeline.items.get('2').editable).toBe(false)
    expect(timeline.items.get('2').className).toContain('task-locked')

    const lockedCallback = vi.fn()
    timeline.options.onMoving({
      ...timeline.items.get('2'),
      start: new Date('2025-01-01T10:00:00'),
      end: new Date('2025-01-01T10:30:00'),
    }, lockedCallback)
    expect(lockedCallback).toHaveBeenCalledWith(null)
    expect(wrapper.emitted('task-update')).toBeUndefined()

    const editableCallback = vi.fn()
    timeline.options.onMove({
      ...timeline.items.get('1'),
      start: new Date('2025-01-01T10:15:00'),
      end: new Date('2025-01-01T11:05:00'),
    }, editableCallback)
    expect(editableCallback).toHaveBeenCalledOnce()
    expect(wrapper.emitted('task-update')).toEqual([[
      { id: '1', start: '10:15:00', finish: '11:05:00' },
    ]])

    wrapper.unmount()
  })
})
