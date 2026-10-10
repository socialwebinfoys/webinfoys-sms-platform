import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development, proxy API calls to the Express backend on port 5000 so the
// frontend can call "/api/..." without CORS concerns.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
