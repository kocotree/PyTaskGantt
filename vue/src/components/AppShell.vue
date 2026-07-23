<template>
  <n-layout class="app-layout">
    <n-layout-header bordered class="app-header">
      <router-link class="header-logo" to="/schedule" aria-label="任务看板首页">
        <span class="header-logo-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="8" height="2.2" rx="1" fill="currentColor" />
            <rect x="5" y="7" width="9" height="2.2" rx="1" fill="currentColor" opacity=".85" />
            <rect x="3" y="11" width="7" height="2.2" rx="1" fill="currentColor" opacity=".7" />
          </svg>
        </span>
        <span>
          <strong class="header-title">RPA 任务看板</strong>
          <small class="header-subtitle">排班沙盘与运行状态</small>
        </span>
      </router-link>

      <nav class="app-nav" aria-label="主导航">
        <router-link to="/schedule">全员任务</router-link>
        <router-link to="/my-tasks">我的任务</router-link>
      </nav>

      <div class="header-user">
        <n-avatar round size="small" :src="auth.user?.avatar_url || undefined">
          {{ initials }}
        </n-avatar>
        <span class="header-user-name">{{ auth.user?.display_name || '当前用户' }}</span>
        <n-tag v-if="auth.user?.is_admin" size="small" type="error" :bordered="false">管理员</n-tag>
        <n-button
          v-if="auth.feishuEnabled && !auth.user?.feishu_bound"
          text
          size="small"
          @click="handleBindFeishu"
        >绑定飞书</n-button>
        <n-button text size="small" @click="handleLogout">退出</n-button>
      </div>
    </n-layout-header>

    <n-layout-content class="app-content">
      <slot />
    </n-layout-content>

    <n-layout-footer bordered class="app-footer">
      PyTaskGantt · RPA 任务排班与执行看板
    </n-layout-footer>
  </n-layout>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAvatar, NButton, NLayout, NLayoutContent, NLayoutFooter, NLayoutHeader, NTag } from 'naive-ui'
import { auth, feishuAuthorizationUrl, logout } from '../services/authService.js'
import { hasAnyUnsavedTasks, resetAllTaskStores } from '../stores/taskDraftStore.js'

const router = useRouter()
const route = useRoute()
const initials = computed(() => (auth.user?.display_name || '用户').trim().slice(0, 1))

async function handleLogout() {
  if (hasAnyUnsavedTasks() && !window.confirm('退出登录会丢弃未保存的任务修改，是否继续？')) return
  try {
    await logout()
  } finally {
    resetAllTaskStores()
    await router.replace('/login')
  }
}

function handleBindFeishu() {
  if (hasAnyUnsavedTasks() && !window.confirm('绑定飞书会离开当前页面，未保存的任务修改将丢失。是否继续？')) return
  window.location.assign(feishuAuthorizationUrl({ intent: 'bind', redirect: route.fullPath }))
}
</script>
