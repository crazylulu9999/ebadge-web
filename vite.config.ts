import { defineConfig } from 'vite'

// Relative base so the build works under https://<user>.github.io/<repo>/
// without needing to hardcode the repository name.
export default defineConfig({
  base: './',
  // Vite's default 5173 falls inside a Windows-reserved TCP range (Hyper-V/WSL
  // reserve 5130–5229 here), which makes the dev server fail with EACCES. Use a
  // port outside the reserved ranges so `pnpm dev` works out of the box.
  server: {
    port: 3000,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
})
