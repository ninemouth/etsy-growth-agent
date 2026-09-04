import { spawnSync } from "node:child_process";
const testScripts = [
  "test:edge-v2",
  "test:control-center-auth",
  "test:adspower-task",
  "test:draft-writer",
  "test:privacy-mask",
  "test:task-logs",
  "test:browser-capabilities",
  "test:extension-surface",
];
for (const script of ["lint", ...testScripts]) {
  console.log(`\n=== npm run ${script} ===`);
  const result = spawnSync("npm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\nrelease test suite passed (${testScripts.length} smoke suites + lint)`);
