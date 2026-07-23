import { reactive, readonly } from 'vue'
import { ApiError, apiRequest } from './apiClient.js'

const authState = reactive({
  initialized: false,
  loading: false,
  authenticated: false,
  user: null,
  authMode: 'dev',
  uiRefreshSeconds: 10,
})

let sessionPromise = null

function applySession(payload = {}) {
  authState.authenticated = Boolean(payload.authenticated && payload.user)
  authState.user = authState.authenticated ? payload.user : null
  authState.authMode = payload.auth_mode || authState.authMode || 'dev'
  const refreshSeconds = Number(payload.ui_refresh_seconds)
  if (Number.isFinite(refreshSeconds) && refreshSeconds >= 5) {
    authState.uiRefreshSeconds = refreshSeconds
  }
  authState.initialized = true
  return authState.user
}

export async function loadSession({ force = false } = {}) {
  if (authState.initialized && !force) return authState.user
  if (sessionPromise) return sessionPromise
  authState.loading = true
  sessionPromise = apiRequest('/auth/session', { skipAuthRedirect: true })
    .then(applySession)
    .catch(error => {
      if (error instanceof ApiError && error.status === 401) return applySession({ authenticated: false })
      authState.initialized = true
      throw error
    })
    .finally(() => {
      authState.loading = false
      sessionPromise = null
    })
  return sessionPromise
}

export async function listDevUsers() {
  const payload = await apiRequest('/auth/dev/users', { skipAuthRedirect: true })
  return Array.isArray(payload) ? payload : payload?.users || []
}

export async function switchDevUser(userId) {
  const payload = await apiRequest('/auth/dev/switch', {
    method: 'POST',
    body: { user_id: userId },
    skipAuthRedirect: true,
  })
  applySession(payload)
  return authState.user
}

export async function logout() {
  try {
    await apiRequest('/auth/logout', { method: 'POST', skipAuthRedirect: true })
  } finally {
    clearSession()
  }
}

export function clearSession() {
  authState.authenticated = false
  authState.user = null
  authState.initialized = true
}

export const auth = readonly(authState)
