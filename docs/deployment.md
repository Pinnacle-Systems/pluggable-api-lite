# Deployment — Hostinger VPS with CloudPanel

This project uses **in-place deployment**: each successful `main` build is
copied to the same directory, replacing earlier application files.
**No release directories, previous-version backups or automated rollback.**

| Setting | Value |
|---|---|
| Server IP | `193.203.160.198` |
| Domain | `bsa-erp.pinnaclesystems.co.in` |
| CloudPanel site user | `pinnaclesystems-bsa-erp` |
| Application directory | `/home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in` |
| Node app port | `9765` |
| Runtime | Node.js 24 |
| Package manager | pnpm 11.13.0 |
| Process manager | systemd |

CloudPanel handles NGINX and HTTPS. Application listens only on
`127.0.0.1:9765`. Do **not** open 9765 to the public.

## 1. One-time VPS setup

Set the CloudPanel **Node.js Site** to **Node.js 24** and **App Port 9765**.
Enable a valid HTTPS certificate for the domain.

SSH as the CloudPanel site user:

```sh
ssh pinnaclesystems-bsa-erp@193.203.160.198
cd /home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in
node -v
npm install -g pnpm@11.13.0
pnpm -v
command -v node  # record absolute path for systemd
```

Check `node -v` is v24.x. If not, select Node.js 24 in CloudPanel and
reconnect via SSH.

Install **Oracle Instant Client 19c Basic for Linux x86-64** on the VPS.
The Windows Instant Client ZIP used for development will not work here.
Check the server architecture first with `uname -m`. For a ZIP
installation, register the **actual** Instant Client library directory in
`/etc/ld.so.conf.d/oracle-instantclient.conf` and run `sudo ldconfig`.
Verify `ldconfig -p | grep libclntsh`.

Oracle 11g requires Thick mode. On Linux, do **not** set
`ORACLE_CLIENT_LIB_DIR` in `.env`: `oracledb.initOracleClient()`
must find the library via the OS dynamic linker.

Ensure the VPS can reach the Oracle server; use a **SELECT-only** DB user.

## 2. Production .env (one-time)

Create a `.env` **on the VPS only**, in the CloudPanel site directory:

```sh
cd /home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in
nano .env
chmod 600 .env
```

Populate with real values (do not post them in chat or commit them):

```dotenv
DB_CONNECT_STRING=<oracle-host>:1521/<service>
DB_USER=<readonly-username>
DB_PASSWORD=<password>
API_KEY=<long-random-key>
HOST=127.0.0.1
PORT=9765
```

The GitHub workflow **preserves `.env`** (and `.well-known/`) during
in-place file synchronization. It never uploads credentials.

## 3. systemd automatic startup (one-time)

Create `/etc/systemd/system/pluggable-api-lite.service` as root.
Replace `<absolute-node-path>` with the **real** output from
`command -v node` while logged in as the CloudPanel site user with Node 24
active. Do not use a wildcard. The unit launches Node directly, so
no PM2 or cron entry is required.

```ini
[Unit]
Description=Pluggable API Lite (BSA ERP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pinnaclesystems-bsa-erp
WorkingDirectory=/home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in
Environment=NODE_ENV=production
ExecStart=<absolute-node-path> --env-file=.env src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable pluggable-api-lite.service
```

The service is enabled for **automatic startup after server reboot**.
Do not start it before the first deployment has placed the application files.

For automatic GitHub deployment, the Site User must be able to restart **only
this service** without a password. Create
`/etc/sudoers.d/pluggable-api-lite-deploy` using
`sudo visudo -f /etc/sudoers.d/pluggable-api-lite-deploy` and enter:

```text
pinnaclesystems-bsa-erp ALL=(root) NOPASSWD: /usr/bin/systemctl restart pluggable-api-lite.service
```

Verify the location of `systemctl` with `command -v systemctl` and adjust
the sudoers entry and deployment script if different. Do not grant unrestricted
passwordless sudo.

## 4. SSH access for GitHub Actions

1. Generate a dedicated **Ed25519 SSH key pair** on a trusted local machine
   (`ssh-keygen -t ed25519 -f github-pluggable-api-lite`).
2. Add the public key to the CloudPanel Site User's SSH authorized keys
   (CloudPanel → site → Site User → SSH Keys).
3. Add the private key as GitHub Actions **secret** `DEPLOY_SSH_KEY`.
4. Save a verified SSH server host-key entry as Actions **secret**
   `DEPLOY_KNOWN_HOSTS`. To obtain a candidate:
   `ssh-keyscan -p 22 193.203.160.198`. Verify its fingerprint
   against the VPS's own SSH host public key via a trusted channel
   **before** saving it; do not trust a scan alone.
5. Verify key-based login as the Site User and GitHub runner SSH access.
   Restrictive firewalls can prevent GitHub-hosted runners from connecting.

Repository → **Settings → Secrets and variables → Actions**.

**Variables:**

| Variable | Value |
|---|---|
| `DEPLOY_HOST` | `193.203.160.198` |
| `DEPLOY_USER` | `pinnaclesystems-bsa-erp` |
| `DEPLOY_PORT` | `22` (or your actual SSH port; not 9765) |
| `DEPLOY_PATH` | `/home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in` |
| `APP_PORT` | `9765` |
| `DEPLOY_ENABLED` | `true` **only after the server is ready** |

**Secrets:** `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`.

## 5. How CI/CD runs

Workflow: `.github/workflows/ci-deploy.yml`.

- On pushes and PRs, run `pnpm install --frozen-lockfile` and `pnpm test`.
- On successful pushes to `main`, or manual runs against `main`,
  deploy **only if** `DEPLOY_ENABLED=true`.
- SSH to the CloudPanel Site User, `rsync` code into the CloudPanel
  htdocs directory, install production dependencies with
  `pnpm install --prod --frozen-lockfile`, then restart the systemd service and verify `http://127.0.0.1:9765/health`.

`rsync --delete` removes old application files absent from Git, while
preserving excluded `.env`, `.well-known/` and `node_modules/`.
**Do not store any other irreplaceable files inside the application
directory**, since deployment may delete them.

For the first deployment, after configuration and the PR merge, set
`DEPLOY_ENABLED=true` and run **Actions → CI and VPS deploy → Run workflow**
on `main`.

## 6. Verify and troubleshoot

```sh
sudo systemctl status pluggable-api-lite.service
sudo journalctl -u pluggable-api-lite.service -n 50 --no-pager
curl -fsS http://127.0.0.1:9765/health
```

Public check: `https://bsa-erp.pinnaclesystems.co.in/health`.
An actual Oracle read requires a valid `X-API-Key` and a configured model.

Service auto-start is configured by `systemctl enable`; the systemd unit
also restarts the application if Node exits unexpectedly.

**Caveat:** This is a deliberately simple **in-place deployment**, not an
atomic release. If the deployment or health check fails, GitHub Actions
reports failure, but code may already have changed on the server. There
is no automatic rollback. Avoid concurrent manual edits to the site
directory; keep sensitive API routes restricted.
