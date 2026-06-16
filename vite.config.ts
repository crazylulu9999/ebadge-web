import { defineConfig } from 'vite'

// Relative base so the build works under https://<user>.github.io/<repo>/
// without needing to hardcode the repository name.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
})
