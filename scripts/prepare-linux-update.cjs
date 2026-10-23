"use strict";

// This updater helper deliberately uses only Node built-ins. It can inspect a
// release before npm has installed that release's dependencies, and it never
// imports or executes code from the archive.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const http = require("node:http");

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_TAR_BYTES = 512 * 1024 * 1024;
const REQUIRED_FILES = [
  "package.json", "package-lock.json", "index.html", "server/index.cjs",
  "scripts/check-syntax.cjs", "scripts/backup-mysql.cjs", "scripts/migrate-mysql.cjs",
  "deploy/linux/start.sh", "deploy/linux/install.sh",
];
const CODE_DIRECTORIES = new Set(["src", "server", "scripts", "deploy", "node_modules", "public", ".git"]);

function fail(message) { throw new Error(message); }
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function noSymlinkAncestors(target) {
  let cursor = path.resolve(target);
  while (true) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) fail("Symbolic links are not allowed in deployment paths.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function validateAppDir(input) {
  if (typeof input !== "string" || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) {
    fail("The application directory must be an absolute path.");
  }
  const directory = path.resolve(input);
  if (directory === path.parse(directory).root) fail("The filesystem root cannot be an application directory.");
  if (process.platform !== "win32") {
    const protectedTrees = ["/bin", "/sbin", "/usr", "/etc", "/dev", "/proc", "/sys", "/run", "/boot", "/lib", "/lib64", "/root", "/var/lib", "/var/log", "/var/cache"];
    if (protectedTrees.some((entry) => inside(entry, directory)) || ["/opt", "/srv", "/home", "/tmp", "/var", "/var/www"].includes(directory)) {
      fail("Refusing to use a system directory as the application directory.");
    }
  }
  noSymlinkAncestors(directory);
  if (!fs.statSync(directory).isDirectory()) fail("The application directory is not a directory.");
  return directory;
}

function safeRelative(input) {
  if (typeof input !== "string" || !input || /[\\\x00-\x1f]/.test(input) || input.startsWith("/") || /^[a-z]:/i.test(input)) {
    fail("Invalid relative path in release or preserved directory.");
  }
  const value = input.replace(/\/$/, "");
  const parts = value.split("/");
  if (!value || parts.some((part) => !part || part === "." || part === "..")) fail("Unsafe path in release or preserved directory.");
  return value;
}

function tarString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarOctal(block, start, length) {
  const raw = tarString(block, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) fail("Unsupported or invalid numeric tar header.");
  const number = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(number)) fail("Tar header number is too large.");
  return number;
}

function parsePax(buffer) {
  const result = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < 0) fail("Invalid PAX header.");
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail("Invalid PAX record length.");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > buffer.length || buffer[offset + length - 1] !== 10) fail("Invalid PAX record.");
    const record = buffer.subarray(space + 1, offset + length - 1).toString("utf8");
    const equal = record.indexOf("=");
    if (equal < 1) fail("Invalid PAX field.");
    const key = record.slice(0, equal);
    if (!["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"].includes(key)) fail("Unsupported PAX field in release.");
    if (Object.hasOwn(result, key)) fail("Duplicate PAX field.");
    result[key] = record.slice(equal + 1);
    offset += length;
  }
  return result;
}

function inspectArchive(archivePath) {
  if (!/\.tar\.gz$/i.test(archivePath)) fail("The release must be a .tar.gz archive.");
  const stat = fs.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_BYTES) fail("Invalid release archive or archive exceeds 128 MiB.");
  let buffer;
  try { buffer = zlib.gunzipSync(fs.readFileSync(archivePath), { maxOutputLength: MAX_TAR_BYTES }); }
  catch (_) { fail("The release is not a valid gzip archive, or expands beyond 512 MiB."); }
  const entries = [];
  const paths = new Map();
  let top = "";
  let offset = 0;
  let longName = "";
  let pax = null;
  let ended = false;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (longName || pax) fail("Dangling extended tar header.");
      if (buffer.length < offset + 1024 || !buffer.subarray(offset).every((byte) => byte === 0)) fail("Invalid tar end marker or trailing data.");
      ended = true;
      break;
    }
    const expectedChecksum = tarOctal(block, 148, 8);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : block[index];
    if (checksum !== expectedChecksum) fail("Tar header checksum does not match.");
    const magic = tarString(block, 257, 6);
    if (magic !== "ustar" && magic !== "ustar ") fail("Only ustar or GNU tar releases are supported.");
    const type = tarString(block, 156, 1) || "0";
    let size = tarOctal(block, 124, 12);
    const mode = tarOctal(block, 100, 8);
    if (pax && Object.hasOwn(pax, "size")) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(pax.size)) fail("Invalid PAX size.");
      size = Number(pax.size);
    }
    if (!Number.isSafeInteger(size) || size > MAX_TAR_BYTES || offset + 512 + size > buffer.length) fail("Invalid or truncated tar payload.");
    const contents = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L" || type === "x") {
      if (longName || pax) fail("Stacked extended tar headers are not supported.");
      if (size > 65536) fail("Extended tar header is too large.");
      if (type === "L") longName = contents.toString("utf8").replace(/\x00$/, "");
      else pax = parsePax(contents);
      continue;
    }
    if (type !== "0" && type !== "5") fail("Release archives may contain only regular files and directories; links and devices are forbidden.");
    if (tarString(block, 157, 100)) fail("Unexpected tar link target.");
    let name = longName || pax && pax.path || tarString(block, 0, 100);
    const prefix = magic === "ustar" ? tarString(block, 345, 155) : "";
    if (!longName && !(pax && pax.path) && prefix) name = `${prefix}/${name}`;
    longName = "";
    pax = null;
    const fullName = safeRelative(name);
    const pieces = fullName.split("/");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(pieces[0])) fail("Invalid top-level release directory.");
    if (top && top !== pieces[0]) fail("The archive must contain exactly one top-level directory.");
    top = pieces[0];
    const relative = pieces.slice(1).join("/");
    if (!relative && type !== "5") fail("The archive top level must be a directory.");
    if (type === "5" && size !== 0) fail("Directory entries must have no payload.");
    if (paths.has(relative)) fail("Duplicate archive paths are forbidden.");
    paths.set(relative, type);
    entries.push({ path: relative, type: type === "5" ? "directory" : "file", mode, contents });
    if (entries.length > 50000) fail("The release contains too many entries.");
  }
  if (!ended || !top) fail("Incomplete or empty tar archive.");
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      if (paths.has(parent) && paths.get(parent) !== "5") fail("A file is used as an archive parent directory.");
      parent = path.posix.dirname(parent);
    }
  }
  for (const required of REQUIRED_FILES) {
    if (paths.get(required) !== "0") fail(`Required release file is missing: ${required}`);
  }
  let manifest;
  try { manifest = JSON.parse(entries.find((entry) => entry.path === "package.json").contents.toString("utf8")); }
  catch (_) { fail("Invalid package.json in release."); }
  if (manifest.name !== "luxiaoming-admin" || !manifest.scripts || ["check", "backup:mysql", "migrate:mysql"].some((key) => !manifest.scripts[key])) {
    fail("The archive is not a compatible luxiaoming-admin release.");
  }
  return { top, entries };
}

// Match dotenv's quoted values, comments and multiline PEM/JSON values without
// loading dotenv from either the running application or the untrusted release.
function parseDotenv(source) {
  const result = {};
  const lines = source.toString().replace(/\r\n?/g, "\n");
  const pattern = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  let match;
  while ((match = pattern.exec(lines)) !== null) {
    let value = (match[2] || "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    result[match[1]] = value;
  }
  return result;
}

function paymentReferences(env) {
  const result = [];
  for (const [name, value] of Object.entries(env)) {
    if (/^WECHAT_PAY_.*_PATH$/.test(name) && String(value).trim()) result.push({ label: name, file: String(value).trim() });
  }
  if (String(env.WECHAT_PAY_PLATFORM_VERIFIERS || "").trim()) {
    let verifiers;
    try { verifiers = JSON.parse(env.WECHAT_PAY_PLATFORM_VERIFIERS); }
    catch (_) { fail("WECHAT_PAY_PLATFORM_VERIFIERS is not valid JSON."); }
    if (!Array.isArray(verifiers)) fail("WECHAT_PAY_PLATFORM_VERIFIERS must be an array.");
    for (const [index, entry] of verifiers.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("Invalid payment platform verifier.");
      for (const key of ["publicKeyPath", "certificatePath"]) {
        if (String(entry[key] || "").trim()) result.push({ label: `WECHAT_PAY_PLATFORM_VERIFIERS[${index}].${key}`, file: String(entry[key]).trim() });
      }
    }
  }
  return result;
}

function readRuntimeConfig(appDir, originalDir = appDir) {
  const envFile = path.join(appDir, ".env");
  if (!fs.lstatSync(envFile).isFile()) fail("The existing .env must be a regular file.");
  noSymlinkAncestors(envFile);
  const env = parseDotenv(fs.readFileSync(envFile));
  const port = Number(env.PORT || 5192);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("PORT must be an integer between 1 and 65535.");
  if (String(env.DB_AUTO_MIGRATE || "false").trim().toLowerCase() === "true") {
    fail("Set DB_AUTO_MIGRATE=false before updating; schema changes require an explicit --migrate.");
  }
  const references = paymentReferences(env).map((entry) => {
    if (/[\x00-\x1f]/.test(entry.file)) fail("Invalid payment file path.");
    const source = path.resolve(originalDir, entry.file);
    const internal = inside(originalDir, source);
    return { label: entry.label, source, internal, target: internal ? path.join(appDir, path.relative(originalDir, source)) : source };
  });
  return { port, host: String(env.HOST || "0.0.0.0").trim() || "0.0.0.0", references };
}

function inspectPreserved(source, destination, output) {
  noSymlinkAncestors(source);
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    output.push({ source, destination, directory: true });
    for (const name of fs.readdirSync(source)) inspectPreserved(path.join(source, name), path.join(destination, name), output);
  } else if (stat.isFile()) {
    output.push({ source, destination, directory: false });
  } else fail("Preserved paths must contain only regular files and directories.");
}

function prepareRelease({ archivePath, currentDir, nextDir, preserve = [] }) {
  currentDir = validateAppDir(currentDir);
  if (!path.isAbsolute(nextDir)) fail("The staging directory must be an absolute path.");
  nextDir = path.resolve(nextDir);
  if (inside(currentDir, nextDir) || inside(nextDir, currentDir)) fail("The staging and application directories must be separate.");
  noSymlinkAncestors(nextDir);
  if (fs.existsSync(nextDir)) fail("The staging directory already exists; refusing to overwrite it.");
  const runtime = readRuntimeConfig(currentDir);
  const archive = inspectArchive(archivePath);
  const copies = [];
  inspectPreserved(path.join(currentDir, ".env"), path.join(nextDir, ".env"), copies);
  const directories = new Set(preserve.map(safeRelative));
  if (fs.existsSync(path.join(currentDir, "certs"))) directories.add("certs");
  for (const directory of directories) {
    if (CODE_DIRECTORIES.has(directory.split("/")[0]) || directory.split("/").some((part) => part === ".env" || part === "package.json" || part === "package-lock.json")) {
      fail("Preserved directories cannot replace application code or its manifest.");
    }
    const source = path.join(currentDir, directory);
    if (!fs.statSync(source).isDirectory()) fail("Each --preserve path must be an existing directory.");
    inspectPreserved(source, path.join(nextDir, directory), copies);
  }
  for (const reference of runtime.references) {
    if (reference.internal) {
      const relative = path.relative(currentDir, reference.source);
      if (!relative || CODE_DIRECTORIES.has(relative.split(path.sep)[0]) || REQUIRED_FILES.includes(relative.split(path.sep).join("/")) || relative === ".env") {
        fail("Payment files cannot replace application code or .env.");
      }
      if (!fs.lstatSync(reference.source).isFile()) fail(`Payment file is not a regular file: ${reference.label}`);
      inspectPreserved(reference.source, path.join(nextDir, relative), copies);
    } else {
      if (!fs.statSync(reference.source).isFile()) fail(`Payment file is not a regular file: ${reference.label}`);
      if (inside(currentDir, fs.realpathSync(reference.source))) fail("An external payment path must not link back into the application directory.");
      fs.accessSync(reference.source, fs.constants.R_OK);
    }
  }
  // All archive and source validation precedes the first staging write.
  fs.mkdirSync(nextDir, { mode: 0o750 });
  for (const entry of archive.entries) {
    if (!entry.path || entry.path === ".env") continue;
    const destination = path.join(nextDir, entry.path);
    if (entry.type === "directory") fs.mkdirSync(destination, { recursive: true, mode: 0o750 });
    else {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o750 });
      fs.writeFileSync(destination, entry.contents, { flag: "wx", mode: entry.mode & 0o111 ? 0o750 : 0o640 });
    }
  }
  const seen = new Set();
  for (const copy of copies) {
    if (seen.has(copy.destination)) continue;
    seen.add(copy.destination);
    if (copy.directory) fs.mkdirSync(copy.destination, { recursive: true, mode: 0o700 });
    else {
      fs.mkdirSync(path.dirname(copy.destination), { recursive: true, mode: 0o700 });
      if (fs.existsSync(copy.destination) && !fs.lstatSync(copy.destination).isFile()) fail("Preserved file conflicts with an archive directory.");
      fs.copyFileSync(copy.source, copy.destination);
      fs.chmodSync(copy.destination, 0o600);
    }
  }
  fs.chmodSync(path.join(nextDir, ".env"), 0o600);
  for (const name of ["install.sh", "start.sh", "update.sh"]) {
    const file = path.join(nextDir, "deploy", "linux", name);
    if (fs.existsSync(file)) {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"));
      fs.chmodSync(file, 0o750);
    }
  }
  return { port: runtime.port, preservedFiles: copies.filter((copy) => !copy.directory).length, externalPaymentFiles: runtime.references.filter((entry) => !entry.internal).length };
}

function validateReferences(appDir, originalDir = appDir) {
  const config = readRuntimeConfig(appDir, originalDir);
  for (const reference of config.references) {
    try {
      if (!fs.statSync(reference.target).isFile()) fail("not a file");
      fs.accessSync(reference.target, fs.constants.R_OK);
    } catch (_) { fail(`The service user cannot read payment material: ${reference.label}`); }
  }
  return { checked: config.references.length };
}

async function waitForHealth(appDir, timeoutSeconds = 60) {
  const config = readRuntimeConfig(appDir);
  const host = ["0.0.0.0", "*"].includes(config.host) ? "127.0.0.1" : ["::", "[::]"].includes(config.host) ? "::1" : config.host;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      let request;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // An inactivity timeout alone can be extended forever by a response that
      // keeps sending bytes. This timer also covers DNS, connect and streaming.
      const timer = setTimeout(() => {
        if (request) request.destroy();
        finish(false);
      }, Math.min(3000, Math.max(1, deadline - Date.now())));
      request = http.get({ hostname: host, port: config.port, path: "/api/health" }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 65536) {
            request.destroy();
            finish(false);
          }
        });
        response.on("end", () => {
          try { finish(response.statusCode === 200 && JSON.parse(body).ok === true); }
          catch (_) { finish(false); }
        });
        response.on("aborted", () => finish(false));
        response.on("error", () => finish(false));
      });
      request.on("error", () => finish(false));
    });
    if (ok) return { ok: true, port: config.port };
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
  }
  fail("Health check did not return HTTP 200 and JSON ok=true within the timeout.");
}

async function main(argv) {
  const command = argv.shift();
  const options = { preserve: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--archive", "--current", "--next", "--preserve", "--app", "--original", "--timeout"].includes(key) || !argv[index + 1]) fail("Invalid updater helper arguments.");
    const value = argv[++index];
    if (key === "--preserve") options.preserve.push(value);
    else options[key.slice(2)] = value;
  }
  let result;
  if (command === "validate") result = { appDir: validateAppDir(options.app) };
  else if (command === "prepare") result = prepareRelease({ archivePath: options.archive, currentDir: options.current, nextDir: options.next, preserve: options.preserve });
  else if (command === "config") {
    const config = readRuntimeConfig(options.app);
    result = { port: config.port, host: config.host };
  } else if (command === "references") result = validateReferences(options.app, options.original);
  else if (command === "health") {
    const seconds = Number(options.timeout || 60);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) fail("Invalid health timeout.");
    result = await waitForHealth(options.app, seconds);
  } else fail("Unknown updater helper command.");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  // Deliberately omit error stacks, environment values and health response bodies.
  const message = error.code && ["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR"].includes(error.code)
    ? `Deployment file check failed (${error.code}); check the package, preserved paths and permissions.`
    : error.message;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

module.exports = { REQUIRED_FILES, inspectArchive, parseDotenv, prepareRelease, readRuntimeConfig, validateAppDir, validateReferences, waitForHealth };
