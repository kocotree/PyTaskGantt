import { createRouter, createWebHistory } from 'vue-router'
import { auth, clearSession, loadSession } from './services/authService.js'
import { setUnauthorizedHandler } from './services/apiClient.js'
import {
  discardAllDrafts,
  hasAnyTaskSaveInProgress,
  hasAnyUnsavedTasks,
  resetAllTaskStores,
} from './stores/taskDraftStore.js'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/schedule' },
    { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
    { path: '/schedule', name: 'schedule', component: () => import('./pages/SchedulePage.vue') },
    { path: '/my-tasks', name: 'my-tasks', component: () => import('./pages/MyTasksPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to, from) => {
  try {
    await loadSession()
  } catch (error) {
    if (!to.meta.public) return { name: 'login', query: { error: error.message } }
  }

  if (to.name === 'login' && auth.authenticated) return { name: 'schedule' }
  if (!to.meta.public && !auth.authenticated) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }

  if (from.name && from.fullPath !== to.fullPath && hasAnyTaskSaveInProgress()) {
    window.alert('任务正在保存，请等待保存完成后再离开页面。')
    return false
  }
  if (from.name && from.fullPath !== to.fullPath && hasAnyUnsavedTasks()) {
    const confirmed = window.confirm('当前有未保存的任务修改，离开页面将丢弃这些修改。是否继续？')
    if (!confirmed) return false
    discardAllDrafts()
  }
  return true
})

setUnauthorizedHandler(async () => {
  const redirect = router.currentRoute.value.meta.public ? undefined : router.currentRoute.value.fullPath
  clearSession()
  resetAllTaskStores()
  await router.replace({ name: 'login', query: redirect ? { redirect } : {} })
})

export default router
