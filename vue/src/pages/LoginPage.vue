<template>
  <main class="login-page">
    <n-card class="login-card" :bordered="false">
      <div class="login-brand">
        <span class="header-logo-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="8" height="2.2" rx="1" fill="currentColor" />
            <rect x="5" y="7" width="9" height="2.2" rx="1" fill="currentColor" opacity=".85" />
            <rect x="3" y="11" width="7" height="2.2" rx="1" fill="currentColor" opacity=".7" />
          </svg>
        </span>
        <div>
          <h1>RPA 任务看板</h1>
          <p>{{ auth.authMode === 'feishu' ? '使用飞书账号安全登录' : '选择开发用户进入排班沙盘' }}</p>
        </div>
      </div>

      <n-alert v-if="route.query.error || error" type="error" :show-icon="true" class="login-alert">
        {{ route.query.error || error }}
      </n-alert>

      <template v-if="auth.authMode === 'dev'">
        <n-spin :show="loading">
          <div v-if="users.length" class="login-user-list">
            <button
              v-for="user in users"
              :key="user.id"
              type="button"
              class="login-user-card"
              :disabled="switchingId === String(user.id)"
              @click="chooseUser(user)"
            >
              <n-avatar round :src="user.avatar_url || undefined">{{ user.display_name?.slice(0, 1) }}</n-avatar>
              <span><strong>{{ user.display_name }}</strong><small>用户 ID：{{ user.id }}</small></span>
              <n-spin v-if="switchingId === String(user.id)" size="small" />
              <span v-else aria-hidden="true">→</span>
            </button>
          </div>
          <n-empty v-else-if="!loading" description="暂无可用开发用户" />
        </n-spin>
      </template>

      <div v-if="auth.feishuEnabled" class="feishu-login-action">
        <span v-if="auth.authMode === 'dev'" class="login-divider">或</span>
        <n-button type="primary" size="large" block @click="loginWithFeishu">
          使用飞书登录
        </n-button>
      </div>
      <n-alert v-else-if="auth.authMode === 'feishu'" type="error" :show-icon="true">
        飞书登录配置不完整，请联系管理员。
      </n-alert>

      <p class="login-footnote">
        {{ auth.authMode === 'dev' ? '开发用户切换仅用于本地与测试环境。' : '登录即表示使用飞书身份建立本系统会话。' }}
      </p>
    </n-card>
  </main>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NAvatar, NButton, NCard, NEmpty, NSpin, useMessage } from 'naive-ui'
import { auth, feishuAuthorizationUrl, listDevUsers, loadSession, switchDevUser } from '../services/authService.js'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const users = ref([])
const loading = ref(true)
const switchingId = ref('')
const error = ref('')

onMounted(async () => {
  try {
    await loadSession({ force: true })
    if (auth.authenticated) return router.replace('/schedule')
    if (auth.authMode === 'dev') users.value = await listDevUsers()
  } catch (reason) {
    error.value = reason.message || '登录信息加载失败'
  } finally {
    loading.value = false
  }
})

async function chooseUser(user) {
  switchingId.value = String(user.id)
  try {
    await switchDevUser(user.id)
    message.success(`已切换为 ${user.display_name}`)
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
      ? route.query.redirect
      : '/schedule'
    await router.replace(redirect)
  } catch (reason) {
    error.value = reason.message || '用户切换失败'
  } finally {
    switchingId.value = ''
  }
}

function loginWithFeishu() {
  const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
    ? route.query.redirect
    : '/schedule'
  window.location.assign(feishuAuthorizationUrl({ intent: 'login', redirect }))
}
</script>
