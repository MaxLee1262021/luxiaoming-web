# Linux Deployment

[中文部署、后台常驻与打包运行说明](部署运行说明.md)

[后台发布打包规范](../../docs/后台发布打包规范.md)

This package runs the integrated management UI and API with Node.js. It connects to the configured external MySQL and Redis services; it does not start database containers.

Use a system-wide Node.js 24 LTS installation (Node.js 22 LTS is also supported). The service account must be able to find `node` and `npm` outside a personal nvm directory. The systemd unit restarts an exited process after five seconds; `systemctl stop` still stops it normally.

## Node.js Service

1. Extract the new release and place its application root at `/opt/luxiaoming-admin`. Keep any previous release separately for rollback.
2. Create the dedicated service account if needed: `sudo useradd --system --user-group --home /opt/luxiaoming-admin --shell /usr/sbin/nologin luxiaoming`.
3. Give the account ownership of the application directory: `sudo chown -R luxiaoming:luxiaoming /opt/luxiaoming-admin`.
4. Provision `.env` on the deployment host from `.env.example` or the existing deployment configuration, and run `chmod 600 .env`. The default archive does not contain `.env`.
5. Install runtime dependencies: `sudo -u luxiaoming ./deploy/linux/install.sh`.
6. Before enabling WeChat Pay, take a verified database backup and run `sudo -u luxiaoming npm run migrate:mysql -- --apply`; it adds durable payment transaction fields and the `out_trade_no` uniqueness constraint. For an existing normalized database, then add the OSS metadata table with `sudo -u luxiaoming npm run migrate:files -- --schema` if not already present. This command does not migrate or remove business tables.
7. Run `sudo -u luxiaoming npm run oss:check`; after write permissions are configured, run `sudo -u luxiaoming npm run oss:check -- --write-test` to verify a temporary object's upload, private access, and cleanup.
8. Copy `deploy/linux/luxiaoming-admin.service` to `/etc/systemd/system/`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now luxiaoming-admin`.

The service listens on `0.0.0.0:${PORT:-5192}`. Verify it with `curl -fsS http://127.0.0.1:${PORT:-5192}/api/health` and inspect logs with `sudo journalctl -u luxiaoming-admin -f`.

## Docker Compose

From the extracted package root, run `docker compose --env-file .env -f deploy/linux/compose.yaml up -d --build`. The Docker image does not contain `.env`; Compose injects it only at runtime. The container listens on port 5192; `PORT` in `.env` selects the published host port. Check logs with `docker compose --env-file .env -f deploy/linux/compose.yaml logs -f` and check health at `http://127.0.0.1:5192/api/health` (replace 5192 with the configured host port).

## Configuration

The default release excludes `.env`. Set MySQL, Redis, WeChat and OSS configuration on the target host. `OSS_BUCKET`, `OSS_REGION`, `OSS_ACCESS_KEY_ID` and `OSS_ACCESS_KEY_SECRET` are required for file operations. The example region is `cn-shanghai`, the example endpoint is `https://oss-cn-shanghai.aliyuncs.com`, and the default prefix is `luxiaoming/prod/`. Use the actual bucket region. `OSS_SESSION_TOKEN` and a custom HTTPS `OSS_READ_DOMAIN` are optional.

For WeChat Pay, configure the API v3 merchant fields from `.env.example`, including the merchant private key, APIv3 key, platform verification key/certificate and a public HTTPS `WECHAT_PAY_NOTIFY_URL`. Keep both old and new platform verifiers during key rotation. Reverse-proxy `/api/payments/wechat/notify` directly to this Node service without modifying the request body. See [WeChat Pay integration](../../docs/微信支付接入说明.md).

Production uses real WeChat Pay only. `PAYMENT_MODE=mock` and `PAYMENT_MODE=test` are limited to isolated JSON test environments; they must not be enabled in a release deployment. New payments use JSAPI/prepay, callback verification and transaction-query confirmation.

Use one private bucket. Public catalog media is served through stable application `/api/media/:fileId` redirects; avatars, customer evidence, delivery files and finance attachments require authenticated access. Forward `/api/media/` and `/api/files/` to the Node service. Configure browser CORS and WeChat request/uploadFile/downloadFile domains as documented in [OSS setup and migration](../../docs/OSS接入与迁移.md). The required RAM template is included at `docs/oss-ram-policy.json`; no bucket ACL change is required.

The upload limits are JPEG/PNG/WebP at 20 MiB for ordinary images, 5 MiB for avatars, 50 MiB for delivery photos, and MP4 at 500 MiB for content/delivery video.

## Building a Release

From the source project, run `npm run package:linux -- --name RELEASE_NAME` with a new name for each release. The output directory, `.tar.gz` and `.tar.gz.sha256` appear beside the source project. Existing output directories, `.tar` files, archives or checksum files cause an error and remain unchanged. Upload the archive and checksum file together; run `sha256sum -c RELEASE_NAME.tar.gz.sha256` in their directory before updating. Deployment shell scripts are packaged with LF line endings and mode `0755`.

For an explicitly configured delivery, append `--include-env`; only that option includes the local `.env`, with archive mode `0600`. Both variants include the OSS guide, WeChat Pay guide and RAM policy. The old `20260915` release is not overwritten. Deployment packages omit isolated test directories; run `npm test` in the source project and `npm run check` in the deployment package.

## Repeatable systemd Updates

Once `deploy/linux/update.sh` is installed, upload each new archive and its checksum to `/tmp`, verify the checksum, then run:

```bash
sudo bash /opt/luxiaoming-admin/deploy/linux/update.sh /tmp/RELEASE_NAME.tar.gz
```

The updater prepares dependencies before downtime, preserves the server `.env`, configured payment key/certificate files inside the application directory, and the `certs` directory. It then stops the service, backs up MySQL, switches the application directory and verifies `/api/health` using Node.js. For updates without a schema migration, a failed start or health check attempts to restore and restart the previous code. Existing systemd configuration and overrides are retained. Add `--preserve relative/directory` for additional server-managed files. The previous code and database backup remain available.

Append `--migrate` only when that release requires the MySQL schema migration. Once migration starts, a migration, start or health-check failure leaves the service stopped for manual review, without automatic code or database rollback. Order workflow data migration remains a separate operation.

For the first update from an older release without this updater, extract the complete verified new archive into a temporary directory, then run its `deploy/linux/update.sh` against the original archive. The updater needs the accompanying `scripts/prepare-linux-update.cjs`; do not copy the shell script alone. See the [Chinese update instructions](部署运行说明.md#7-后续更新与回退) for copyable commands. The existing system-wide Node.js installation can be reused.

## Historical Files

Run `npm run migrate:files -- --inventory` to read the database and write a restricted manifest outside the repository at `../.oss-migration/<runId>.json`. Review it, then use `npm run migrate:files -- --apply --manifest PATH`; the same manifest supports resuming. `--rollback --manifest PATH` restores references only when they still match the migrated state, preserves concurrent edits, and does not delete source or newly uploaded objects. See the OSS guide for unavailable originals, cloud references and local source directory requirements.

## Target Database Verification

On 2026-09-17, `migrate:files -- --schema` added `lxm_mediaFiles`, and the MySQL health check reported `ready=true` across 30 normalized tables. Keep `DB_AUTO_MIGRATE=false`.

The historical inventory at `../.oss-migration/oss-20260917022002026.json` found 40 SVG demonstration placeholders and no recoverable real photos or videos. These references were not modified or claimed as migrated files. The manifest is outside the source repository and is not packaged.

The current OSS credentials passed the real write test: V4 POST upload, private ACL verification, signed reads, anonymous-read rejection, overwrite rejection, and temporary-object cleanup. Keep the bucket private and Block Public Access enabled. Run `npm run oss:check -- --write-test` again after any credential, Bucket policy, or endpoint change.
