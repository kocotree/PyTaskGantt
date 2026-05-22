import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 第 3 个参数传 '' 表示读取所有变量（不限定 VITE_ 前缀），
  // 这样可以直接拿 PORT 注入到前端，避免再维护一个 VITE_API_PORT。
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.PORT || '3002'
  const devPort = Number(env.VITE_DEV_PORT) || 5174
  const devHost = env.VITE_DEV_HOST || '0.0.0.0'

  return {
    plugins: [vue()],
    server: {
      port: devPort,
      host: devHost,
    },
    // 把后端端口暴露给前端代码（编译期字符串替换）
    define: {
      'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
    },
  }
})
