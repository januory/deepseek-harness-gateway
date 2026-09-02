import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/health': 'http://127.0.0.1:3300',
      '/nodes': 'http://127.0.0.1:3300',
      '/gw': 'http://127.0.0.1:3300',
      '/console': 'http://127.0.0.1:3300',
      '/agent': { target: 'ws://127.0.0.1:3300', ws: true },
    },
  },
  build: { outDir: 'dist' },
  base: '/portal/',
})
