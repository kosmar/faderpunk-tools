import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// GitHub Pages project site: https://kosmar.github.io/faderpunk-tools/scopepunk/
const pagesBase = process.env.GITHUB_PAGES === "1" ? "/faderpunk-tools/scopepunk/" : "/";

export default defineConfig({
  base: pagesBase,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 3850,
  },
});
