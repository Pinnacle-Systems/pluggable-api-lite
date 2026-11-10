# Deploy Pluggable API Lite to Hostinger / CloudPanel

This follows the MuthuPrinters deployment pattern: manual GitHub Actions
deployment via `easingthemes/ssh-deploy` and `appleboy/ssh-action`, with
automatic tests run first. The application runs under **PM2**, and
**systemd restarts the site user's PM2 daemon after a VPS reboot**.

Deployment overwrites application files **in place**, with no release
directories, copies of earlier versions, or automatic rollback.

| Item | Value |
|---|---|
| VPS IP | `193.203.160.198` |
| CloudPanel domain | `bsa-erp.pinnaclesystems.co.in` |
| CloudPanel site user | `pinnaclesystems-bsa-erp` |
| Application directory | `/home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in` |
| Node.js app port | `9765` |
| Node.js | 24 |
| pnpm | 11.13.0 |
| Process name | `pluggable-api-lite` |
| PM2 systemd unit | Usually `pm2-pinnaclesystems-bsa-erp.service` |

CloudPanel should reverse-proxy public HTTPS to `127.0.0.1:9765`.
Keep that port private; it is not the SSH port.

## 1. Check the CloudPanel Node.js site

In CloudPanel, confirm:
- Domain `bsa-erp.pinnaclesystems.co.in`
- Node.js version **24**
- App Port **9765**
- A valid TLS/Let's Encrypt certificate for the domain
- The Site User `pinnaclesystems-bsa-erp` is enabled for SSH key login

If CloudPanel created a placeholder app on port 9765, stop its process
only after identifying it; don't leave two applications trying to listen
on the same port.

## 2. Prepare Node, pnpm, PM2 and Oracle client (VPS, once)

Log in with the CloudPanel Site User and run:

```sh
ssh pinnaclesystems-bsa-erp@193.203.160.198
cd /home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in
whoami
node -v
npm install -g pnpm@11.13.0 pm2
pnpm -v
pm2 -v
```

The Node version must be v24.x. If necessary, select Node 24 in CloudPanel,
reconnect, and verify `node -v` again.

Oracle 11g needs **Thick mode**. Install **Linux x86-64 Oracle Instant
Client 19c Basic** (not the Windows Instant Client ZIP). Verify the VPS
architecture with `uname -m`. Install the OS dependencies required by
your particular Linux version. For an Instant Client ZIP installed under
`/opt/oracle/instantclient_19_xx` (replace this example with the real
extracted path), register that folder as root:

```sh
echo /opt/oracle/instantclient_19_xx | sudo tee /etc/ld.so.conf.d/oracle-instantclient.conf
sudo ldconfig
ldconfig -p | grep libclntsh
```

On Linux, `ORACLE_CLIENT_LIB_DIR` should **not** be set: the API calls
`oracledb.initOracleClient()` without a library path and the OS loader
finds the client library. Ensure the VPS can reach the Oracle listener
and use a SELECT-only database user.

## 3. Configure production environment (VPS, once)

Create this file **on the server**, not in GitHub:

```sh
cd /home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in
nano .env
chmod 600 .env
```

Enter your real values:

```dotenv
DB_CONNECT_STRING=<oracle-host>:1521/<service>
DB_USER=<select-only-user>
DB_PASSWORD=<secret>
API_KEY=<long-random-secret>
HOST=127.0.0.1
PORT=9765
```

Do not copy `ORACLE_CLIENT_LIB_DIR` from the Windows development
environment.

The workflow deploys **only** `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `src/`, and `config/`. It will not upload
or overwrite `.env`, CloudPanel's `.well-known/`, or the site's
`node_modules/`.

**Security:** `.env` lives in the site directory because the existing
application starts with `node --env-file=.env`. Verify CloudPanel/Nginx
does not serve dotfiles such as `.env` over HTTP. Never commit the
file or post its contents.

## 4. Register PM2 under systemd (VPS, once)

Check whether the Site User already has a PM2 startup service, using
the root/server administration terminal:

```sh
sudo systemctl is-enabled pm2-pinnaclesystems-bsa-erp.service
sudo systemctl status pm2-pinnaclesystems-bsa-erp.service --no-pager
```

If already enabled, **do not create a second service**.

Otherwise, log in as `pinnaclesystems-bsa-erp` and run:

```sh
pm2 startup systemd -u pinnaclesystems-bsa-erp --hp /home/pinnaclesystems-bsa-erp
```

Copy and execute the **exact sudo command printed by PM2** in a
privileged shell. It includes the Node.js/PM2 PATH required at boot.
The resulting unit is normally
`pm2-pinnaclesystems-bsa-erp.service`. No cron or separate systemd
service for this Node application is required.

The GitHub deployment script starts/reloads the API and runs `pm2 save`
**after the health check succeeds** so the saved PM2 process list is
restored on reboot. After initial deployment, verify:

```sh
pm2 status
sudo systemctl is-enabled pm2-pinnaclesystems-bsa-erp.service
curl -fsS http://127.0.0.1:9765/health
```

PM2 uses the Site User's own home and PM2 state. Do not run `pm2 start`
as root. If you later update the nvm-managed Node version, regenerate
the PM2 startup service so its PATH points to the new version.

## 5. SSH credentials for GitHub Actions (once)

On your local Windows machine, generate a **dedicated** deploy key
(not your personal login key):

```powershell
ssh-keygen -t ed25519 -C "github-actions-pluggable-api-lite" -f "$env:USERPROFILE\.ssh\pluggable_api_deploy"
```

For this unattended GitHub Actions key, leave the passphrase empty.
Protect the private key and never commit or share it.

Show the public key only:

```powershell
Get-Content "$env:USERPROFILE\.ssh\pluggable_api_deploy.pub"
```

Add it to the CloudPanel Site User's authorized SSH keys.

Test from Windows:

```powershell
ssh -i "$env:USERPROFILE\.ssh\pluggable_api_deploy" pinnaclesystems-bsa-erp@193.203.160.198 "whoami"
```

Expected: `pinnaclesystems-bsa-erp`.

Verify the server's **SSH host identity** from the Hostinger console
(or another independently trusted admin access):

```sh
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Save the displayed `SHA256:...` fingerprint as
`DEPLOY_HOST_FINGERPRINT` in GitHub secrets.

From your local computer, obtain a candidate `known_hosts` entry:

```sh
ssh-keyscan -t ed25519 -p 22 193.203.160.198
```

Compare its public-key material/fingerprint with the trusted server key
**before** saving the whole host-key line as `DEPLOY_KNOWN_HOSTS`.
If the server uses a nonstandard SSH port, update both commands and
GitHub's `DEPLOY_PORT` accordingly.

Add the complete private key text to the GitHub Actions secret
`DEPLOY_SSH_KEY` (locally from your protected private-key file). Never
put private keys in repository variables or workflow YAML.

## 6. GitHub settings

Repository: `Pinnacle-Systems/pluggable-api-lite`

Go to **Settings → Secrets and variables → Actions**.

Set these **Variables**:

| Variable | Value |
|---|---|
| `DEPLOY_HOST` | `193.203.160.198` |
| `DEPLOY_USER` | `pinnaclesystems-bsa-erp` |
| `DEPLOY_PORT` | `22` (unless SSH uses another port) |
| `DEPLOY_PATH` | `/home/pinnaclesystems-bsa-erp/htdocs/bsa-erp.pinnaclesystems.co.in` |
| `APP_PORT` | `9765` |

Set these **Secrets**:

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Dedicated Ed25519 private key |
| `DEPLOY_KNOWN_HOSTS` | Verified server SSH known_hosts line |
| `DEPLOY_HOST_FINGERPRINT` | Verified server SSH SHA256 host fingerprint |

Avoid placing production DB credentials or the API key in GitHub.

## 7. First run and subsequent deployments

1. Merge the CI/CD pull request after checks pass.
2. Finish the server prerequisites: Node 24, pnpm, PM2, Instant Client 19c,
   `.env`, SSH key and systemd startup for PM2.
3. Add the GitHub Actions variables and secrets above.
4. In GitHub, select **Actions → CI and VPS deploy → Run workflow**,
   branch **main**.
5. The tests must pass before GitHub deploys files.
6. GitHub uploads code in place, installs production dependencies, reloads
   (or initially starts) `pluggable-api-lite` under PM2, validates
   `127.0.0.1:9765/health` and runs `pm2 save`.

After deployment, check:

```sh
pm2 status
pm2 logs pluggable-api-lite --lines 50
curl -fsS http://127.0.0.1:9765/health
```

Check the public endpoint at
`https://bsa-erp.pinnaclesystems.co.in/health`. Test an authorized
`GET /api/<model>` separately to verify Oracle connectivity.

**Important limitation:** This deliberately follows MuthuPrinters' in-place
source transfer without `rsync --delete`. Changed files are overwritten,
but files removed from Git can remain on disk and must be removed manually
if needed. No previous-version directory is retained. A failed deployment
may leave partially updated files; there is no automatic rollback.

If the app is not restored after a VPS reboot, inspect:

```sh
sudo systemctl status pm2-pinnaclesystems-bsa-erp.service --no-pager
sudo journalctl -u pm2-pinnaclesystems-bsa-erp.service -n 100 --no-pager
```
