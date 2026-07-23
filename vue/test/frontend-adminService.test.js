// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverTask } from '../src/services/taskService.js'

afterEach(() => vi.restoreAllMocks())

describe('administrator task service', () => {
  it('恢复历史任务只提交目标用户、计划和版本到专用管理员端点', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
      text: async () => '',
    })
    await recoverTask('9007199254740993', '8', 'schedule-recovered', 4)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/api\/admin\/tasks\/9007199254740993\/recover$/)
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      owner_user_id: '8',
      schedule_uuid: 'schedule-recovered',
      version: 4,
    })
    expect(options.credentials).toBe('include')
  })
})
