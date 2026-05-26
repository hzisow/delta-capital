import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Data flow: browser → Vite → /api proxy → Python sidecar (FastAPI + yfinance
// + curl_cffi). The sidecar handles Yahoo's WAF for us via Chrome TLS
// impersonation. See sidecar.py.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
