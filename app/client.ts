import { createClient } from 'honox/client'

createClient()

// eruda 调试面板仅开发环境启用：生产构建不加载，避免悬浮按钮遮挡 Toast
if (import.meta.env.DEV) {
  void import('eruda').then((eruda) => eruda.default.init())
}
