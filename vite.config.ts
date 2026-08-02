import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Keep CSS minification disabled so the build works consistently on
// Windows, Netlify Linux and browser-based Codespaces without an optional
// native lightningcss binary.
export default defineConfig({
  plugins: [react()],
  build: {
    cssMinify: false,
  },
})
