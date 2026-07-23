// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const routerState = vi.hoisted(() => ({
  auth: {
    authenticated: false,
    user: null,
    initialized: true,
    authMode: 'dev',
    uiRefreshSeconds: 10,
  },
  unsaved: false,
  saving: false,
  unauthorizedHandler: null,
  discarded: 0,
  reset: 0,
}))

vi.mock('../src/services/authService.js', () => ({
  auth: routerState.auth,
  loadSession: vi.fn(async () => routerState.auth.user),
  clearSession: vi.fn(() => {
    routerState.auth.authenticated = false
    routerState.auth.user = null
  }),
}))

vi.mock('../src/services/apiClient.js', () => ({
  setUnauthorizedHandler(handler) {
    routerState.unauthorizedHandler = handler
  },
}))

vi.mock('../src/stores/taskDraftStore.js', () => ({
  hasAnyUnsavedTasks: () => routerState.unsaved,
  hasAnyTaskSaveInProgress: () => routerState.saving,
  discardAllDrafts: () => { routerState.discarded += 1 },
  resetAllTaskStores: () => { routerState.reset += 1 },
}))

import router from '../src/router.js'

describe('router authentication and draft guards', () => {
  beforeEach(async () => {
    routerState.auth.authenticated = false
    routerState.auth.user = null
    routerState.unsaved = false
    routerState.saving = false
    routerState.discarded = 0
    routerState.reset = 0
    vi.restoreAllMocks()
    await router.replace('/login')
  })

  it('匿名访问业务页跳登录；登录后阻止误丢草稿，并在 401 时清理状态', async () => {
    await router.push('/my-tasks')
    expect(router.currentRoute.value).toMatchObject({
      name: 'login',
      query: { redirect: '/my-tasks' },
    })

    routerState.auth.authenticated = true
    routerState.auth.user = { id: '1', display_name: '用户甲' }
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('schedule')

    routerState.unsaved = true
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    await router.push('/my-tasks')
    expect(router.currentRoute.value.name).toBe('schedule')
    expect(routerState.discarded).toBe(0)

    window.confirm.mockReturnValueOnce(true)
    await router.push('/my-tasks')
    expect(router.currentRoute.value.name).toBe('my-tasks')
    expect(routerState.discarded).toBe(1)

    routerState.unsaved = false
    await routerState.unauthorizedHandler()
    expect(routerState.auth.authenticated).toBe(false)
    expect(routerState.reset).toBe(1)
    expect(router.currentRoute.value).toMatchObject({
      name: 'login',
      query: { redirect: '/my-tasks' },
    })
  })
})
