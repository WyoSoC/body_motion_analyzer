import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          mediapipe: ['@mediapipe/tasks-vision'],
          chart: ['chart.js'],
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision']
  },
  server: {
    sourcemapIgnoreList: (path) => path.includes('node_modules'),
  }
})
