import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// The UI builds into dist/, which server.ts serves. There is no dev server: the API checks Origin
// against 127.0.0.1:7777, so `bun run dev` rebuilds on save and the page is always served by the deck.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
})
