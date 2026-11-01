import { chmodSync } from "node:fs";

if (process.platform !== "win32") chmodSync("dist/cli.js", 0o755);
