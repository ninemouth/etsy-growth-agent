import { spawnSync } from "node:child_process";
import pkg from "../package.json" with { type: "json" };

const testScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith("test:") && name !== "test:release").sort();
for (const script of ["lint", ...testScripts]) {
  console.log(`\n=== npm run ${script} ===`);
  const result = spawnSync("npm", ["run", script], { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\nrelease test suite passed (${testScripts.length} smoke suites + lint)`);
