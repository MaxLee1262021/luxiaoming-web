"use strict";

// Creates a source-only Linux release. Runtime secrets are opt-in, and existing
// release directories or archives are never removed or replaced.
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const crypto = require("crypto");
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
  return { outputRoot, tarFile: outputRoot + ".tar", archiveFile: outputRoot + ".tar.gz", checksumFile: outputRoot + ".tar.gz.sha256" };
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
  const { outputRoot, tarFile, archiveFile, checksumFile } = outputs;
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
    "docs/最新订单流程与迁移.md",
    "docs/商家分成实施与验收-20261106.md",
    "docs/商家分成发布说明-20261107.md",
    "docs/商家二维码扫码统计修复-20261113.md",
    "docs/merchant-share.env.example",
    "docs/摄影师分成实施与验收-20261111.md",
    "docs/摄影师分成存量清理-20261111.md",
    "docs/摄影师账号同步创建-20261113.md",
    "docs/客服工作台与分成开发验收-20261111.md",
    "docs/客服工作台查询优化-20261111.md",
    "docs/后台查询性能优化-20261111.md",
    "docs/后台发布说明-20261111-r1.md",
    "docs/后台发布说明-20261112-r1.md",
    "docs/后台发布说明-20261113-r1.md",
    "docs/后台发布说明-20261114-r3.md",
    "docs/后台发布说明-20261115-r1.md",
    "docs/后台发布说明-20261116-r5.md",
    "docs/后台发布说明-20261116-r6.md",
    "docs/后台发布说明-20261117-r1.md",
    "docs/后台发布说明-20261118-r1.md",
    "docs/后台发布说明-20261118-r2.md",
    "docs/后台发布说明-20261119-r2.md",
    "docs/后台发布说明-20261122-r1.md",
    "docs/后台发布说明-20261122-r2.md",
    "docs/后台发布说明-20261123-r1.md",
    "docs/后台发布说明-20261123-r2.md",
    "docs/后台发布说明-20261127-r1.md",
    "docs/总工作台开发与验收-20261120.md",
    "docs/总工作台企微联系接入-20261120.md",
    "docs/商品小程序外链-20261119.md",
    "docs/商家码最近扫码归属规则-20261118.md",
    "docs/physical-commerce.env.example",
    "docs/周边商品交易开发与部署-20261115.md",
    "docs/快递100与微信实物物流接入-20261115.md",
    "docs/客服模块原型界面还原-20261112.md",
    "docs/客服模块字段对齐与样式回退-20261112.md",
    "docs/客服账号直接创建-20261113.md",
    "docs/客服企微自动邀请-20261119.md",
    "docs/客服个人时效编辑-20261113.md",
    "docs/客服比例列表同步修复-20261113.md",
    "docs/预约定金与须知配置-20261113.md",
    "docs/旅拍灵感模块说明.md",
    "docs/商品规格与库存管理-20261105.md",
    "docs/真实数据源切换-20261105.md",
    "docs/mysql-guides-add-columns-20261105.sql",
    "docs/真实库旅拍灵感补列计划-20261105.md",
    "docs/后台发布打包规范.md",
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
          && !relative.startsWith(path.join("src", "mock"))
          && !["public/public-data.js", "server/seed.cjs", "server/lib/seed.cjs", "server/lib/mockSource.cjs", "scripts/api-smoke.cjs"].includes(relative.split(path.sep).join("/"))
          && !relative.split(path.sep).includes("tests")
          && !(name === ".env" || name.startsWith(".env.") && name !== ".env.example");
      }
    });
  }

  const shellScripts = [];
  function normalizeShellScripts(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const script = path.join(directory, entry.name);
      if (entry.isDirectory()) normalizeShellScripts(script);
      else if (entry.isFile() && entry.name.endsWith(".sh")) {
        // Normalize all deployment scripts, including future update helpers.
        const scriptText = fs.readFileSync(script, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        fs.writeFileSync(script, scriptText, { encoding: "utf8" });
        fs.chmodSync(script, 0o755);
        shellScripts.push(`${packageName}/${path.relative(outputRoot, script).split(path.sep).join("/")}`);
      }
    }
  }
  normalizeShellScripts(path.join(outputRoot, "deploy", "linux"));
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
    ...shellScripts.map((script) => `--exclude=${script}`),
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
    ...shellScripts
  ]);
  if (options.includeEnv) runTar(["--append", "--format=gnu", "--mode=0600", "-f", tarFileName, `${packageName}/.env`]);
  fs.writeFileSync(archiveFile, zlib.gzipSync(fs.readFileSync(tarFile), { level: zlib.constants.Z_BEST_COMPRESSION }), { flag: "wx", mode: 0o600 });
  fs.unlinkSync(tarFile);
  const checksum = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");
  fs.writeFileSync(checksumFile, `${checksum}  ${path.basename(archiveFile)}\n`, { flag: "wx", mode: 0o600 });

  return { directory: outputRoot, archive: archiveFile, checksum: checksumFile, includesEnv: options.includeEnv };
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
