// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

function response(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

describe('Feishu auth frontend state', () => {
  it('reads Feishu availability from session and builds a same-API authorization start URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({
      authenticated: false,
      user: null,
      auth_mode: 'feishu',
      feishu_enabled: true,
      ui_refresh_seconds: 10,
    }))
    const { auth, feishuAuthorizationUrl, loadSession } = await import('../src/services/authService.js')

    await loadSession({ force: true })
    expect(auth.authMode).toBe('feishu')
    expect(auth.feishuEnabled).toBe(true)
    const url = new URL(feishuAuthorizationUrl({ intent: 'bind', redirect: '/my-tasks?tab=mine' }))
    expect(url.pathname).toBe('/api/auth/feishu/start')
    expect(url.searchParams.get('intent')).toBe('bind')
    expect(url.searchParams.get('redirect')).toBe('/my-tasks?tab=mine')
  })
})
