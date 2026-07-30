import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: change "acls-monitor" below to your actual GitHub repository name.
// If your repo is https://github.com/yourname/my-sim, set base to "/my-sim/".
export default defineConfig({
  plugins: [react()],
  base: "/ACLS_monitor/",
});
