import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    // The build number lets the app tell whether a newer build has been published.
    define: { __BUILD_NUMBER__: JSON.stringify(Number(process.env.CHAUDECAL_BUILD ?? 0) || 0) },
    build: { rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {
    resolve: { alias }
  },
  renderer: {
    resolve: { alias },
    plugins: [react()]
  }
})
