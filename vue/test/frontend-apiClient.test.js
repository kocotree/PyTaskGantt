import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, setUnauthorizedHandler } from '../src/services/apiClient.js'

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

describe('api client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    setUnauthorizedHandler(null)
  })

  it('所有请求统一携带会话凭证并发送 JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ success: true }))
    await apiRequest('/tasks/batch', { method: 'POST', body: { mutations: [] } })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, options] = fetchMock.mock.calls[0]
    expect(options.credentials).toBe('include')
    expect(options.headers.get('Content-Type')).toBe('application/json')
    expect(options.body).toBe('{"mutations":[]}')
  })

  it('解析统一错误结构并触发一次 401 处理', async () => {
    const unauthorized = vi.fn()
    setUnauthorizedHandler(unauthorized)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      error: { code: 'AUTH_REQUIRED', message: '请先登录', details: { reason: 'expired' } },
    }, 401))

    await expect(apiRequest('/tasks')).rejects.toMatchObject({
      name: 'ApiError', status: 401, code: 'AUTH_REQUIRED', message: '请先登录',
    })
    await Promise.resolve()
    expect(unauthorized).toHaveBeenCalledOnce()
  })

  it('网络异常转换为可识别的 ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'))
    await expect(apiRequest('/tasks')).rejects.toEqual(expect.objectContaining({
      name: 'ApiError', code: 'NETWORK_ERROR',
    }))
    await expect(apiRequest('/tasks')).rejects.toBeInstanceOf(ApiError)
  })
})
