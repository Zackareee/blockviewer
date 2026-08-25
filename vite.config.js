import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// wasm-bindgen-rayon workers do `import('../../..')` to reach the pkg root.
// wasm-pack normally writes a package.json there; these checkouts don't, so
// Vite's import analysis fails. Point that import at wasm_mesher.js instead.
function wasmBindgenRayonPkg() {
  return {
    name: 'wasm-bindgen-rayon-pkg',
    resolveId(source, importer) {
      if (
        source === '../../..' &&
        importer &&
        importer.includes('wasm-bindgen-rayon') &&
        importer.endsWith('workerHelpers.js')
      ) {
        return path.resolve(path.dirname(importer), '../../../wasm_mesher.js')
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Set base path for GitHub Pages deployment (uses env var or defaults to '/')
  base: process.env.BASE_URL || '/',
  plugins: [
    wasmBindgenRayonPkg(),
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
  // WASM configuration
  optimizeDeps: {
    exclude: ['wasm-mesher'], // Don't pre-bundle WASM
  },
  build: {
    // Ensure WASM files are copied to output
    rollupOptions: {
      output: {
        // Keep WASM files with their original names
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.wasm')) {
            return 'assets/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
  // Worker configuration for ES module workers (required for code-splitting)
  worker: {
    format: 'es',
  },
  // Enable SharedArrayBuffer support with COOP/COEP headers
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Serve textures folder at /textures/
    fs: {
      allow: ['..'],
      // Keep local Rust/Zig toolchains from thrashing HMR
      deny: ['.cargo', '.rustup', '.tools'],
    },
    watch: {
      ignored: ['**/.cargo/**', '**/.rustup/**', '**/.tools/**', '**/src/wasm-mesher/target/**'],
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
