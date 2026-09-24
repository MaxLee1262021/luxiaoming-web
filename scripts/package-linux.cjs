"use strict";

// Creates a source-only Linux release. Runtime secrets are opt-in, and existing
// release directories or archives are never removed or replaced.
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const zlib = require("zlib");

function parseOptions(args) {
  const options = { name: "luxiaoming-admin-linux-20260917-oss", includeEnv: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--include-env") options.includeEnv = true;
    else if (args[i] === "--help" || args[i] === "-h") options.help = true;
    else if (args[i] === "--name") {
      const name = args[++i];
      if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name)) throw new Error("--name must be a single directory name containing only letters, digits, dot, underscore or hyphen.");
      options.name = name;
    } else throw new Error(`Unknown packaging option: ${args[i]}`);
  }
  return options;
}

function resolveOutputs(workspace, packageName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(packageName)) throw new Error("Invalid package name.");
  const parent = path.resolve(workspace);
  const outputRoot = path.resolve(parent, packageName);
  if (path.dirname(outputRoot) !== parent) throw new Error("Package output must stay inside the workspace.");
  return { outputRoot, tarFile: outputRoot + ".tar", archiveFile: outputRoot + ".tar.gz" };
}

function assertOutputsAvailable(outputs) {
  for (const target of Object.values(outputs)) {
    if (fs.existsSync(target)) throw new Error(`Output already exists; choose a new --name: ${target}`);
  }
}

function packageLinux(options) {
  const root = path.resolve(__dirname, "..");
  const workspace = path.resolve(root, "..");
  const packageName = options.name;
  const outputs = resolveOutputs(workspace, packageName);
  const { outputRoot, tarFile, archiveFile } = outputs;
  const tarFileName = path.basename(tarFile);
  const bundledGnuTar = "C:\\Program Files\\Git\\usr\\bin\\tar.exe";
  const tarExecutable = process.env.TAR || (process.platform === "win32" && fs.existsSync(bundledGnuTar) ? bundledGnuTar : "tar");
  const includeFiles = [
    ".env.example",
    "index.html",
    "package.json",
    "package-lock.json",
    "README.md",
    "docs/OSS接入与迁移.md",
    "docs/oss-ram-policy.json",
    "docs/微信支付接入说明.md",
    ...(options.includeEnv ? [".env"] : [])
  ];
  const includeDirectories = ["public", "src", "server", "scripts", "deploy"];

  assertOutputsAvailable(outputs);
  for (const entry of [...includeFiles, ...includeDirectories]) {
    if (!fs.existsSync(path.join(root, entry))) throw new Error(`Required package source missing: ${entry}`);
  }

  // Exclusive creation also prevents concurrent runs from replacing this release.
  fs.mkdirSync(outputRoot);

  for (const file of includeFiles) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) throw new Error(`Required file missing: ${file}`);
    const destination = path.join(outputRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }

  for (const directory of includeDirectories) {
    const source = path.join(root, directory);
    if (!fs.existsSync(source)) throw new Error(`Required directory missing: ${directory}`);
    fs.cpSync(source, path.join(outputRoot, directory), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (entry) => {
        const relative = path.relative(root, entry);
        const name = path.basename(entry);
        return !relative.split(path.sep).includes("node_modules")
          && !relative.split(path.sep).includes(".git")
          && !relative.split(path.sep).includes(".codex-tmp")
          && !relative.startsWith(path.join("server", "data"))
          && !relative.split(path.sep).includes("tests")
          && !(name === ".env" || name.startsWith(".env.") && name !== ".env.example");
      }
    });
  }

for (const script of [
  path.join(outputRoot, "deploy", "linux", "install.sh"),
  path.join(outputRoot, "deploy", "linux", "start.sh")
]) {
  // The source tree is edited on Windows and may carry CRLF. Linux parses the
  // shebang literally, so normalize release launchers before archiving them.
  const scriptText = fs.readFileSync(script, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  fs.writeFileSync(script, scriptText, { encoding: "utf8" });
  fs.chmodSync(script, 0o755);
}
  if (options.includeEnv) fs.chmodSync(path.join(outputRoot, ".env"), 0o600);

  function runTar(args) {
    const result = childProcess.spawnSync(tarExecutable, args, {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tar failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }

  // Only a temporary tar created exclusively by this run is ever removed.
  fs.writeFileSync(tarFile, "", { flag: "wx", mode: 0o600 });
  runTar([
    "-cf",
    tarFileName,
    "--format=gnu",
    `--exclude=${packageName}/.env`,
    `--exclude=${packageName}/deploy/linux/install.sh`,
    `--exclude=${packageName}/deploy/linux/start.sh`,
    packageName
  ]);
  // Windows file modes are not portable. Append authoritative POSIX entries so
  // extraction on Linux restores executable launcher scripts and a private .env.
  runTar([
    "--append",
    "--format=gnu",
    "--mode=0755",
    "-f",
    tarFileName,
    `${packageName}/deploy/linux/install.sh`,
    `${packageName}/deploy/linux/start.sh`
  ]);
  if (options.includeEnv) runTar(["--append", "--format=gnu", "--mode=0600", "-f", tarFileName, `${packageName}/.env`]);
  fs.writeFileSync(archiveFile, zlib.gzipSync(fs.readFileSync(tarFile), { level: zlib.constants.Z_BEST_COMPRESSION }), { flag: "wx", mode: 0o600 });
  fs.unlinkSync(tarFile);

  return { directory: outputRoot, archive: archiveFile, includesEnv: options.includeEnv };
}

if (require.main === module) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log("node scripts/package-linux.cjs [--name PACKAGE_NAME] [--include-env]\nDefault: luxiaoming-admin-linux-20260917-oss; no .env. Existing output paths cause an error and are never overwritten.");
    else console.log(JSON.stringify(packageLinux(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseOptions, resolveOutputs, assertOutputsAvailable };
