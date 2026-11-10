# Hostinger VPS / CloudPanel deployment — BSA ERP

This project deploys the **read-only** Node.js API to VPS `193.203.160.198` using GitHub Actions, SSH and a
systemd service. No Docker or database migration is involved.

The workflow is in `.github/workflows/ci-deploy.yml`.
- Every push and PR to `main` runs `pnpm install --frozen-lockfile` and `pnpm test`.
- On a successful push to `main` (or manual run on `main`), deployment runs
  **only when** GitHub Actions variable `DEPLOY_ENABLED` is `true`.
- A release is copied to `DEPLOY_PATH/releases/<git-sha>`, dependencies are
  installed on the VPS, `current` is updated, the service is restarted, and
  `http://127.0.0.1:9765/health` is checked.
- On restart/health failure, the previous `current` symlink is restored if
  one exists. Old releases remain on disk for manual cleanup.

## 1. CloudPanel (one-time)

1. Create a **Node.js Site** for an API hostname such as `bsa-erp.pinnaclesystems.co.in`.
   Choose **Node.js 24** and **App Port 9765**. The currently configured CloudPanel site is `bsa-erp.pinnaclesystems.co.in` (VPS `193.203.160.198`), with Site User `pinnaclesystems-bsa-erp`. CloudPanel proxies the public
   HTTPS hostname to the local Node.js process; enable a valid TLS certificate.
2. Note the **Site User**. Use this non-root user for SSH deployment and to run
   the Node.js service. You do not need to expose TCP port 9765 publicly.
3. Make sure that the VPS can reach the existing Oracle database over the
   required network/port. Keep Oracle unexposed to the public internet.

## 2. Install Node, pnpm and Oracle Instant Client on the VPS

SSH in as the CloudPanel Site User and verify:

```sh
node -v                    # must be v24.x
npm install -g pnpm@11.13.0
pnpm -v                    # must be 11.13.0
command -v node            # save this absolute path for systemd
```

Install **Linux x86-64 Oracle Instant Client 19c Basic** on the VPS (the
Windows package from local development is not usable on Linux). Verify the VPS
architecture with `uname -m` and install any OS library dependencies reported
by Oracle / `ldd`. For a ZIP installation under
`/opt/oracle/instantclient_19_xx`, register the **real** extracted directory
with the Linux dynamic linker:

```sh
echo /opt/oracle/instantclient_19_xx | sudo tee /etc/ld.so.conf.d/oracle-instantclient.conf
sudo ldconfig
ldconfig -p | grep libclntsh
```

The folder name is an example. On **Linux**, do **not** set
`ORACLE_CLIENT_LIB_DIR` in `.env`; `oracledb.initOracleClient()` must use the
system library search path. Oracle 11g requires Thick mode with the 19c client.

## 3. Create production directories and .env

As the Site User, create a dedicated deployment directory, for example:

```sh
mkdir -p /home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite/releases /home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite/shared
chmod 700 /home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite/shared
nano /home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite/shared/.env
chmod 600 /home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite/shared/.env
```

Fill in the server-side `.env`:

```dotenv
DB_CONNECT_STRING=<oracle-host>:1521/<oracle-service>
DB_USER=<read-only-user>
DB_PASSWORD=<secret>
API_KEY=<long-random-secret>
HOST=127.0.0.1
PORT=9765
```

This file stays **only on the VPS**. The workflow links it into each release.
Never commit database credentials or API keys to GitHub (the repository is
public). Use a database account with SELECT-only permissions.

## 4. Create the systemd service

As root, create `/etc/systemd/system/pluggable-api-lite.service`:

```ini
[Unit]
Description=Pluggable API Lite
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pinnaclesystems-bsa-erp
Group=pinnaclesystems-bsa-erp
WorkingDirectory=/home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite/current
Environment=NODE_ENV=production
ExecStart=<absolute-path-to-node> --env-file=.env src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `pinnaclesystems-bsa-erp` and `<absolute-path-to-node>` with real values.
The node executable path must be the output of `command -v node` run as the
Site User, not a wildcard or a literal placeholder.

```sh
sudo systemctl daemon-reload
sudo systemctl enable pluggable-api-lite.service
```

Do **not** start it before the first release creates the `current` symlink.

The deployment user needs permission to restart **only this service** without
a password. As root use `sudo visudo -f /etc/sudoers.d/pluggable-api-lite-deploy`
and add:

```text
pinnaclesystems-bsa-erp ALL=(root) NOPASSWD: /usr/bin/systemctl restart pluggable-api-lite.service
```

Verify your `systemctl` executable path; substitute it if not `/usr/bin/systemctl`.
This is much safer than granting general passwordless sudo.

## 5. Configure SSH access for GitHub Actions

1. Generate a **dedicated Ed25519 deploy key pair** on a trusted local machine,
   e.g. `ssh-keygen -t ed25519 -f github-pluggable-api-lite -C github-actions-deploy`.
   Use a dedicated, unprivileged Site User for deployment, never root.
2. Put the **public** key into the CloudPanel Site User's SSH authorized keys
   (CloudPanel Site User Settings supports SSH keys).
3. Add the **private** key as a GitHub Actions repository secret:
   `DEPLOY_SSH_KEY`.
4. Add the verified SSH host-key entry for the VPS as a GitHub Actions secret:
   `DEPLOY_KNOWN_HOSTS`. Obtain it with `ssh-keyscan -p <port> <host>`
   from a trusted machine, **compare its fingerprint to the server's
   `/etc/ssh/ssh_host_ed25519_key.pub` fingerprint through an independently
   trusted channel**, then save the resulting full `known_hosts` line.
   For a non-default SSH port, the entry uses `[host]:port`.
5. Confirm SSH allows public-key authentication from the GitHub-hosted runner.
   If a firewall allows only your home IP, the runner will not connect.

GitHub: repository **Settings → Secrets and variables → Actions**.

**Repository variables:**

| Name | Example / meaning |
|---|---|
| `DEPLOY_HOST` | `193.203.160.198` |
| `APP_PORT` | `9765` |
| `DEPLOY_USER` | `pinnaclesystems-bsa-erp` |
| `DEPLOY_PORT` | `22` (optional; defaults to 22) |
| `DEPLOY_PATH` | `/home/pinnaclesystems-bsa-erp/apps/pluggable-api-lite` |
| `DEPLOY_ENABLED` | Set to `true` **last** after server preparation |

**Repository secrets:**

| Name | Content |
|---|---|
| `DEPLOY_SSH_KEY` | Dedicated deploy-key private key |
| `DEPLOY_KNOWN_HOSTS` | Verified SSH host-key entry/entries |

Do not use GitHub Actions to store or overwrite the production `.env`.

## 6. Deploy and verify

1. Merge the CI/CD pull request.
2. Keep `DEPLOY_ENABLED` absent until CloudPanel, Instant Client,
   `.env`, systemd, SSH and GitHub settings are ready.
3. Set `DEPLOY_ENABLED=true` in Actions variables.
4. Use **Actions → CI and VPS deploy → Run workflow** on `main`, or push to
   `main`. The test job must pass before deployment.
5. Confirm `https://bsa-erp.pinnaclesystems.co.in/health` returns `{"status":"ok"}`.
   Then test an authorized `GET /api/<model>` with your API key.

Troubleshoot on the VPS:

```sh
sudo systemctl status pluggable-api-lite.service
sudo journalctl -u pluggable-api-lite.service -n 100 --no-pager
curl -fsS http://127.0.0.1:9765/health
```

If first deploy fails, there is no previous release to roll back to; fix the
problem and rerun. On later deploys, the script rolls back the `current`
symlink after restart or health-check failure. The workflow does not prune old
releases.

**Security:** CloudPanel handles public HTTPS; keep Node bound to loopback,
never expose Oracle credentials, use a SELECT-only Oracle user, and keep SSH
key-only access. API-key auth alone is not a rate limiter; consider firewall
or reverse-proxy restrictions before opening sensitive APIs widely.
