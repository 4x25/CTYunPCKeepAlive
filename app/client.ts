import { createClient } from 'honox/client'

createClient()

// eruda 调试面板：动态 import 单独分包，加载完成后挂载
import('eruda').then((eruda) => eruda.default.init())
