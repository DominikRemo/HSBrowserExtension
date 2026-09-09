// Shared web-ext configuration. The ignore list is the single source of truth
// for what does NOT belong in a distributed build.
export default {
  ignoreFiles: [
    "dist",
    "node_modules",
    "scripts",
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "updates.json",
    "README.md",
    "**/.DS_Store",
  ],
  build: {
    overwriteDest: true,
  },
};
