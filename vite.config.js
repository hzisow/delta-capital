import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// New architecture: frontend reads a static data.json refreshed hourly
// by GitHub Actions (.github/workflows/refresh-data.yml). No sidecar,
// no tunnel, Mac fully off. See VITE_DATA_URL in src/App.jsx.
export default defineConfig({
  plugins: [react()],
})
