// Build an upload-ready Chrome Web Store ZIP of the extension.
//
//   node scripts/build-store-zip.mjs [endpoint]
//
// Produces dist/store/ask-c4s-<version>.zip with:
//   - the default backend endpoint baked in (so testers configure nothing)
//   - dev-only files excluded (README.md, icons/generate.mjs)
//   - localhost host permissions dropped from the manifest
//   - forward-slash ZIP entry names (Chrome rejects backslash subdir paths)
// The source tree under chrome-extension/ is NOT modified (stays localhost for dev).
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, posix } from "node:path";
import { execFileSync } from "node:child_process";

const ENDPOINT = (process.argv[2] || "https://ec2-54-83-232-127.compute-1.amazonaws.com").replace(/\/$/, "");
const SRC = "chrome-extension";
const OUT = join("dist", "store");
const STAGE = join(OUT, "ask-c4s");
const EXCLUDE = new Set(["README.md", posix.join("icons", "generate.mjs")]);
// Local dev endpoints rewritten to the real backend in the packaged build.
// Longer (http://) forms first so the bare forms only catch standalone refs.
const LOCAL = ["http://127.0.0.1:3031", "http://localhost:3031", "127.0.0.1:3031", "localhost:3031"];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

function copyTree(relDir = "") {
  for (const name of readdirSync(join(SRC, relDir))) {
    const rel = relDir ? posix.join(relDir, name) : name;
    if (EXCLUDE.has(rel)) continue;
    const srcPath = join(SRC, rel);
    if (statSync(srcPath).isDirectory()) { mkdirSync(join(STAGE, rel), { recursive: true }); copyTree(rel); }
    else cpSync(srcPath, join(STAGE, rel));
  }
}
copyTree();

// Bake the endpoint into the JS files (constants, inline fallbacks, help strings, comments).
let rewritten = 0;
for (const name of readdirSync(STAGE)) {
  if (!name.endsWith(".js")) continue;
  const p = join(STAGE, name);
  let src = readFileSync(p, "utf8");
  let hits = 0;
  for (const l of LOCAL) { const n = src.split(l).length - 1; hits += n; src = src.split(l).join(ENDPOINT); }
  if (hits) { writeFileSync(p, src); rewritten += hits; console.log(`  baked ${hits} endpoint ref(s) in ${name}`); }
}

// Drop localhost host permissions from the packaged manifest.
const mfPath = join(STAGE, "manifest.json");
const mf = JSON.parse(readFileSync(mfPath, "utf8"));
const before = mf.host_permissions.length;
mf.host_permissions = mf.host_permissions.filter((h) => !/127\.0\.0\.1|localhost/.test(h));
writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");
const version = mf.version;

// Zip with forward-slash entry names. Compress-Archive uses backslashes for
// subdirectories (e.g. icons\icon-16.png), which Chrome cannot resolve against
// the manifest's icons/icon-16.png — so use .NET ZipFile and set entry names.
const zip = join(OUT, `ask-c4s-${version}.zip`);
const stageAbs = resolve(STAGE), zipAbs = resolve(zip), ps1 = join(OUT, "_zip.ps1");
writeFileSync(ps1, [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `$stage = '${stageAbs}'`,
  `$zip = '${zipAbs}'`,
  "if (Test-Path $zip) { Remove-Item $zip -Force }",
  "$z = [System.IO.Compression.ZipFile]::Open($zip, 'Create')",
  "try {",
  "  Get-ChildItem -Recurse -File -LiteralPath $stage | ForEach-Object {",
  "    $rel = $_.FullName.Substring($stage.Length + 1) -replace '\\\\','/'",
  "    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $rel)",
  "  }",
  "} finally { $z.Dispose() }",
].join("\r\n"));
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdio: "inherit" });
rmSync(ps1, { force: true });

console.log(`\nendpoint baked: ${ENDPOINT}  (${rewritten} refs total)`);
console.log(`host_permissions: ${before} -> ${mf.host_permissions.length} (dropped localhost)`);
console.log(`ZIP: ${zip}`);
