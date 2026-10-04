import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
