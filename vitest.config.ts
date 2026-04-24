import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    env: {
      SUPER_ADMIN_EMAILS: "super@thinkcrm.test",
      OPENAI_API_KEY: "sk-test-voice-notes-stub",
    },
  },
});
