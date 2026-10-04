import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      strict: true,
      deny: [
        "**/.env",
        "**/.env.*",
        "**/*.{crt,pem,key}",
        "**/.git/**",
        "**/.data/**",
        "**/*.{sqlite,sqlite-shm,sqlite-wal}",
        "**/server/**",
        "**/electron/**",
        "**/scripts/**",
        "**/test-results/**",
      ],
    },
    watch: {
      ignored: [
        "**/.data/**",
        "**/release/**",
        "**/build/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/tests/**",
      ],
    },
  },
  build: { sourcemap: false },
});
