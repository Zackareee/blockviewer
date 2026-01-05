import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      // Don't clear browser console on fast refresh
      fastRefresh: {
        // Disable console clearing
        include: '**/*.{jsx,tsx}',
      },
    }),
  ],
  // Don't clear terminal on HMR updates
  clearScreen: false,
  // Serve textures folder as additional public assets
  publicDir: 'public',
  // Enable SharedArrayBuffer support with COOP/COEP headers
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Serve textures folder at /textures/
    fs: {
      allow: ['..'],
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
