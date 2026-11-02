import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // RDP proxy runs in its own utilityProcess
          'rdp-proxy-worker': resolve('src/main/rdp/proxy-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    // noVNC has a top-level await that the dev server's pre-bundling rejects; it is plain ESM, so skip that step.
    optimizeDeps: { exclude: ['@novnc/novnc'] },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
