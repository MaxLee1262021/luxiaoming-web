# Linux Deployment

This package runs the integrated management UI and API with Node.js. It connects to the configured external MySQL and Redis services; it does not start database containers.

## Node.js Service

1. Extract the new release and place its application root at `/opt/luxiaoming-admin`. Keep any previous release separately for rollback.
2. Create the dedicated service account if needed: `sudo useradd --system --home /opt/luxiaoming-admin --shell /usr/sbin/nologin luxiaoming`.
3. Give the account ownership of the application directory: `sudo chown -R luxiaoming:luxiaoming /opt/luxiaoming-admin`.
4. Provision `.env` on the deployment host from `.env.example` or the existing deployment configuration, and run `chmod 600 .env`. The default archive does not contain `.env`.
5. Install runtime dependencies: `sudo -u luxiaoming ./deploy/linux/install.sh`.
6. For an existing normalized database, add only the OSS metadata table with `sudo -u luxiaoming npm run migrate:files -- --schema` if not already present. This command does not migrate or remove business tables. For a new database, review `npm run migrate:mysql -- --dry-run` and initialize the full schema using the separate database migration procedure.
7. Run `sudo -u luxiaoming npm run oss:check`; after write permissions are configured, run `sudo -u luxiaoming npm run oss:check -- --write-test` to verify a temporary object's upload, private access, and cleanup.
8. Copy `deploy/linux/luxiaoming-admin.service` to `/etc/systemd/system/`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now luxiaoming-admin`.

The service listens on `0.0.0.0:${PORT:-5192}`. Verify it with `curl -fsS http://127.0.0.1:${PORT:-5192}/api/health` and inspect logs with `sudo journalctl -u luxiaoming-admin -f`.

## Docker Compose

From the extracted package root, run `docker compose -f deploy/linux/compose.yaml up -d --build`. The Docker image does not contain `.env`; Compose injects it only at runtime. Check health with `docker compose -f deploy/linux/compose.yaml logs -f` and `curl -fsS http://127.0.0.1:${PORT:-5192}/api/health`.

## Configuration

The default release excludes `.env`. Set MySQL, Redis, WeChat and OSS configuration on the target host. `OSS_BUCKET`, `OSS_REGION`, `OSS_ACCESS_KEY_ID` and `OSS_ACCESS_KEY_SECRET` are required for file operations. The example region is `cn-shanghai`, the example endpoint is `https://oss-cn-shanghai.aliyuncs.com`, and the default prefix is `luxiaoming/prod/`. Use the actual bucket region. `OSS_SESSION_TOKEN` and a custom HTTPS `OSS_READ_DOMAIN` are optional.

Use one private bucket. Public catalog media is served through stable application `/api/media/:fileId` redirects; avatars, customer evidence, delivery files and finance attachments require authenticated access. Forward `/api/media/` and `/api/files/` to the Node service. Configure browser CORS and WeChat request/uploadFile/downloadFile domains as documented in [OSS setup and migration](../../docs/OSS接入与迁移.md). The required RAM template is included at `docs/oss-ram-policy.json`; no bucket ACL change is required.

The upload limits are JPEG/PNG/WebP at 20 MiB for ordinary images, 5 MiB for avatars, 50 MiB for delivery photos, and MP4 at 500 MiB for content/delivery video.

## Building a Release

From the source project, run `npm run package:linux`. The default output is the adjacent `luxiaoming-admin-linux-20260917-oss` directory and `.tar.gz`. Existing output directories, `.tar` files or `.tar.gz` archives cause an error and remain unchanged. Use `npm run package:linux -- --name luxiaoming-admin-linux-20260917-oss-r2` for a separate release.

For an explicitly configured delivery, append `--include-env`; only that option includes the local `.env`, with archive mode `0600`. Both variants include the OSS guide and RAM policy. The old `20260915` release is not overwritten. Deployment packages omit isolated test directories; run `npm test` in the source project and `npm run check` in the deployment package.

## Historical Files

Run `npm run migrate:files -- --inventory` to read the database and write a restricted manifest outside the repository at `../.oss-migration/<runId>.json`. Review it, then use `npm run migrate:files -- --apply --manifest PATH`; the same manifest supports resuming. `--rollback --manifest PATH` restores references only when they still match the migrated state, preserves concurrent edits, and does not delete source or newly uploaded objects. See the OSS guide for unavailable originals, cloud references and local source directory requirements.

## Target Database Verification

On 2026-09-17, `migrate:files -- --schema` added `lxm_mediaFiles`, and the MySQL health check reported `ready=true` across 30 normalized tables. Keep `DB_AUTO_MIGRATE=false`.

The historical inventory at `../.oss-migration/oss-20260917022002026.json` found 40 SVG demonstration placeholders and no recoverable real photos or videos. These references were not modified or claimed as migrated files. The manifest is outside the source repository and is not packaged.

The current OSS credentials passed the real write test: V4 POST upload, private ACL verification, signed reads, anonymous-read rejection, overwrite rejection, and temporary-object cleanup. Keep the bucket private and Block Public Access enabled. Run `npm run oss:check -- --write-test` again after any credential, Bucket policy, or endpoint change.
