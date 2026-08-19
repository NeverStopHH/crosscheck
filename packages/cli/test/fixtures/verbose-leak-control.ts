/**
 * Control arm for test/bunfig-leak.test.ts: a PLAIN fetch with an
 * Authorization header, exactly what any unshielded bun process in the repo
 * does. Spawned with cwd inside the fixture repo so the debug bunfig
 * applies. If THIS process's stderr does not carry the marker, the fixture
 * is not triggering verbose logging on the running bun and the main
 * assertion would be vacuous — the control keeps the test honest.
 */
export {};

const url = process.argv[2];
if (url === undefined) {
  throw new Error("usage: verbose-leak-control.ts <url>");
}
await fetch(url, {
  headers: { Authorization: "Bearer cx_control_marker_key" },
});
console.log("control done");
