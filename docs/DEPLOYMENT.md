# HMS production deployment — Ubuntu Server + Docker + Cloudflare Tunnel

Target used throughout this guide: **https://hms.trustedsystems.co.ke** (zone `trustedsystems.co.ke` on Cloudflare).
Replace the hostname, organisation names and e-mail addresses with your own where needed.

Time to complete: about 45–60 minutes, most of it waiting for the first Docker build.

---

## Contents

0. [How it fits together](#0-how-it-fits-together)
1. [Prerequisites](#1-prerequisites)
2. [Step 1 — Prepare the Ubuntu server](#2-step-1--prepare-the-ubuntu-server)
3. [Step 2 — Install Docker Engine + Compose](#3-step-2--install-docker-engine--compose)
4. [Step 3 — Get the code onto the server](#4-step-3--get-the-code-onto-the-server)
5. [Step 4 — Create the production `.env`](#5-step-4--create-the-production-env)
6. [Step 5 — Create the Cloudflare Tunnel](#6-step-5--create-the-cloudflare-tunnel)
7. [Step 6 — Build and start the stack](#7-step-6--build-and-start-the-stack)
8. [Step 7 — Seed the database (first run only)](#8-step-7--seed-the-database-first-run-only)
9. [Step 8 — Verify end to end](#9-step-8--verify-end-to-end)
10. [Step 9 — First login and go-live configuration](#10-step-9--first-login-and-go-live-configuration)
11. [Step 10 — Recommended Cloudflare settings](#11-step-10--recommended-cloudflare-settings)
12. [Operations: backups, restore, updates, logs](#12-operations-backups-restore-updates-logs)
13. [Troubleshooting](#13-troubleshooting)
14. [Security checklist](#14-security-checklist)
15. [Appendix A — LAN access without Cloudflare (or in addition to it)](#15-appendix-a--lan-access-without-cloudflare-or-in-addition-to-it)
16. [Appendix B — Environment variable reference](#16-appendix-b--environment-variable-reference)
17. [Appendix C — Command cheat-sheet](#17-appendix-c--command-cheat-sheet)

---

## 0. How it fits together

```
 Staff browser / POS tablet
        │  https://hms.trustedsystems.co.ke   (TLS, WAF, DDoS protection at Cloudflare's edge)
        ▼
 ┌──────────────────┐        outbound-only, encrypted tunnel        ┌────────────────────────────────────────────┐
 │  Cloudflare edge │ ◄─────────────────────────────────────────── │  Ubuntu server  (no inbound ports open)     │
 └──────────────────┘                                              │                                            │
                                                                   │  docker compose -f docker-compose.prod.yml  │
                                                                   │  ┌───────────┐   ┌───────┐   ┌──────────┐  │
                                                                   │  │cloudflared│──►│ nginx │──►│ frontend │  │
                                                                   │  └───────────┘   │  :80  │   │ Next.js  │  │
                                                                   │                  │       │   └──────────┘  │
                                                                   │                  │ /api  │   ┌──────────┐  │
                                                                   │                  │/uploads──►│ backend  │──┐│
                                                                   │                  └───────┘   │ Express  │  ││
                                                                   │                              └──────────┘  ││
                                                                   │  ┌───────────┐   ┌──────────┐              ││
                                                                   │  │ db-backup │──►│ postgres │◄─────────────┘│
                                                                   │  │ (cron)    │   │   :17    │               │
                                                                   │  └───────────┘   └──────────┘               │
                                                                   │  volumes: pgdata · uploads · backups        │
                                                                   └────────────────────────────────────────────┘
```

* **No inbound ports.** `cloudflared` opens an outbound connection to Cloudflare; the server firewall only
  allows SSH. Cloudflare terminates TLS and forwards requests through the tunnel to `nginx:80` inside the
  Docker network.
* **nginx** is the single entry point: `/api/*` and `/uploads/*` go to the backend, everything else to the
  Next.js frontend. It is published only on `127.0.0.1:8080` on the host (handy for local checks, invisible
  from outside).
* **backend** applies database migrations and syncs permissions automatically every time it starts.
* **db-backup** runs `pg_dump` on a cron schedule into the `backups` volume (same volume the in-app
  *Settings → System → Backups* feature uses).
* Persistent data lives in three named Docker volumes: `hms_pgdata`, `hms_uploads`, `hms_backups`.

---

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Server | Ubuntu Server **22.04 LTS or 24.04 LTS**, x86-64 (arm64 also works). Minimum **2 vCPU / 4 GB RAM / 40 GB SSD**; recommended 4 vCPU / 8 GB for a busy multi-outlet property. The first image build needs ~3 GB of free memory — the guide adds swap. |
| Access | Root or a sudo user over SSH; outbound internet (HTTPS 443 and, ideally, UDP 7844 for the tunnel's QUIC transport — HTTP/2 fallback is configurable). |
| Domain | `trustedsystems.co.ke` added to a Cloudflare account and **using Cloudflare nameservers** (the zone shows *Active*). The Free plan is enough. |
| Cloudflare Zero Trust | Enabled once at <https://one.dash.cloudflare.com> (choose a team name; the Free plan covers tunnels). |
| Code | Access to the HMS Git repository (or a copy of the repo folder to upload). |
| Workstation | An SSH client and a browser. |

> **Why a tunnel?** The server never needs a public IP or open ports 80/443 — this works behind Safaricom /
> Zuku / office NAT just as well as on a VPS, and you get Cloudflare TLS, WAF and DDoS protection for free.

---

## 2. Step 1 — Prepare the Ubuntu server

Log in as root (or your provider's default sudo user) and run the following.

### 2.1 Create an admin user with SSH keys

```bash
adduser hms                       # choose a strong password (used for sudo only)
usermod -aG sudo hms
# copy your SSH public key to the new user
mkdir -p /home/hms/.ssh && cp ~/.ssh/authorized_keys /home/hms/.ssh/ 2>/dev/null || true
chown -R hms:hms /home/hms/.ssh && chmod 700 /home/hms/.ssh && chmod 600 /home/hms/.ssh/authorized_keys
```

Open a **second** terminal and confirm `ssh hms@<server-ip>` works with your key before continuing.
Everything from here on is run as `hms`.

### 2.2 Updates, timezone, time sync, basics

```bash
sudo apt-get update && sudo apt-get -y full-upgrade
sudo apt-get install -y ca-certificates curl gnupg git ufw unattended-upgrades apt-listchanges
sudo timedatectl set-timezone Africa/Nairobi
sudo timedatectl set-ntp true
timedatectl            # "System clock synchronized: yes" — business dates and night audit depend on correct time
sudo dpkg-reconfigure -plow unattended-upgrades   # answer Yes → automatic security updates
sudo hostnamectl set-hostname hms-prod
```

### 2.3 Harden SSH

```bash
sudo tee /etc/ssh/sshd_config.d/99-hms.conf >/dev/null <<'EOF'
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
MaxAuthTries 4
EOF
sudo systemctl restart ssh
```

(Keep your existing session open while you re-test key login in another terminal.)

### 2.4 Firewall — SSH only

Because the tunnel is outbound-only, **no web ports are opened**.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw --force enable
sudo ufw status verbose
```

> Docker publishes container ports by writing its own iptables rules, which **bypass UFW**. That is why this
> stack publishes nginx on `127.0.0.1` only (`HTTP_BIND=127.0.0.1` in `.env`) — nothing else is exposed.

### 2.5 Swap (needed for the image builds on 4 GB machines)

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-hms.conf && sudo sysctl -p /etc/sysctl.d/99-hms.conf
free -h
```

### 2.6 (Optional) fail2ban for SSH

```bash
sudo apt-get install -y fail2ban && sudo systemctl enable --now fail2ban
```

---

## 3. Step 2 — Install Docker Engine + Compose

Use Docker's official repository (Ubuntu's `docker.io` package is older and lacks the Compose plugin).

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker hms
newgrp docker            # or log out and back in
docker --version && docker compose version    # Docker 27+/28+, Compose v2.2x+
docker run --rm hello-world
```

Container log rotation is already configured per service in `docker-compose.prod.yml` (10 MB × 5 files).

---

## 4. Step 3 — Get the code onto the server

```bash
sudo mkdir -p /opt/hms && sudo chown hms:hms /opt/hms
git clone <YOUR-REPO-URL> /opt/hms          # e.g. git clone git@github.com:trustedsystems/hms.git /opt/hms
cd /opt/hms
git checkout main                            # or a release tag, e.g. git checkout v1.0.0
chmod +x deploy/backup/backup.sh scripts/*.sh
```

No Git access from the server? Upload the folder from your workstation instead:
`rsync -az --exclude node_modules --exclude .next --exclude .cache --exclude .env ./hms/ hms@<server-ip>:/opt/hms/`.

---

## 5. Step 4 — Create the production `.env`

`/opt/hms/.env` is read by **Docker Compose** (variable substitution) **and** by the backend container
(`env_file`). It must never be committed (it is git-ignored).

### 5.1 Generate secrets

```bash
cd /opt/hms
cp .env.example .env
chmod 600 .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
```

Hex output contains only `0-9a-f`, so it is safe inside the database URL that Compose builds for you.

### 5.2 Edit the file

`nano .env` and set the values below (everything not listed can keep its default):

```dotenv
# ---- Security ----
JWT_SECRET=<paste the generated value>
SESSION_SECRET=<paste the generated value>
SESSION_TTL_MINUTES=480
BCRYPT_ROUNDS=12
MAX_FAILED_LOGINS=5
LOCKOUT_MINUTES=15
TRUST_PROXY_HOPS=1
RATE_LIMIT_API_PER_MINUTE=1200
RATE_LIMIT_LOGIN_PER_15MIN=100

# ---- Backend ----
NODE_ENV=production
CORS_ORIGINS=https://hms.trustedsystems.co.ke

# ---- First-run seed (production) ----
SEED_MODE=minimal
# leave ADMIN_PASSWORD empty here; it is passed once on the command line in Step 7
ADMIN_PASSWORD=
HOTEL_NAME=Trusted Systems Hotel
HOTEL_CODE=TSH
COMPANY_NAME=Trusted Systems Ltd
# KRA PIN (optional, printed on invoices)
COMPANY_TAX_NUMBER=
HOTEL_ADDRESS=Mombasa Road
HOTEL_CITY=Nairobi
HOTEL_COUNTRY=Kenya
HOTEL_PHONE=+254700000000
HOTEL_EMAIL=frontdesk@trustedsystems.co.ke
HOTEL_CURRENCY=KES
HOTEL_TIMEZONE=Africa/Nairobi
SERVICE_CHARGE_PERCENT=10

# ---- Defaults ----
DEFAULT_CURRENCY=KES
DEFAULT_TIMEZONE=Africa/Nairobi

# ---- Deployment (docker-compose) ----
POSTGRES_PASSWORD=<paste the generated value>
# nginx is published on the server's loopback interface only — nothing is reachable from outside
HTTP_BIND=127.0.0.1
HTTP_PORT=8080
# filled in Step 5
CLOUDFLARE_TUNNEL_TOKEN=
# auto (QUIC) — set to http2 if the tunnel cannot connect over UDP/7844
CLOUDFLARE_TUNNEL_PROTOCOL=auto
# make plain `docker compose …` always mean the production stack incl. cloudflared + db-backup
COMPOSE_FILE=docker-compose.prod.yml
COMPOSE_PROFILES=tunnel,backup
BACKUP_CRON=15 2 * * *
BACKUP_KEEP_DAYS=14
```

Notes

* `COMPOSE_FILE` / `COMPOSE_PROFILES` are read by Docker Compose from `.env` in the project directory, so
  for the rest of this guide **`docker compose up -d`** is equivalent to
  `docker compose -f docker-compose.prod.yml --profile tunnel --profile backup up -d`.
  (In `.env.example` those two lines are commented out — remove the leading `#`.)
* `POSTGRES_PASSWORD` is applied when the database volume is first created. Changing it later requires
  `ALTER USER` (see [Troubleshooting](#13-troubleshooting)).
* `DATABASE_URL`, `PORT`, `STORAGE_PATH` and `BACKUP_PATH` in the file are ignored by the production
  stack — Compose sets the container-internal values itself.
* Behind Cloudflare, every request arrives with the real client address in `CF-Connecting-IP`; nginx passes it
  to the API, which is why `TRUST_PROXY_HOPS=1`. A whole property behind one office NAT shares one public IP,
  so the per-IP limits are deliberately generous (account lockout still protects individual logins).

---

## 6. Step 5 — Create the Cloudflare Tunnel

All of this happens in the browser; nothing is installed on the server yet.

1. Go to <https://one.dash.cloudflare.com> → pick your account → **Networks → Tunnels** →
   **Create a tunnel**.
2. Connector type: **Cloudflared** → *Next*.
3. Tunnel name: `hms-prod` → *Save tunnel*.
4. On the **Install and run a connector** page choose **Docker**. You do **not** need to run the command shown —
   just copy the long token that follows `--token` (it begins with `eyJ…`).
5. Put it in the server's `.env`:

   ```bash
   nano /opt/hms/.env      # CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi....
   ```

   The token is a secret: anyone holding it can attach a connector to your tunnel.
6. Click *Next* to reach **Route tunnel → Public Hostnames** and add:

   | Field | Value |
   |---|---|
   | Subdomain | `hms` |
   | Domain | `trustedsystems.co.ke` |
   | Path | *(empty)* |
   | Type | **HTTP** |
   | URL | **`nginx:80`** |

   `nginx` is the container name on the Compose network — `cloudflared` runs on the same network, so it
   resolves directly. Do **not** use `localhost`.
   Under *Additional application settings → HTTP Settings* nothing needs changing (no TLS verify is
   irrelevant for plain HTTP; keep the Host header default).
7. *Save hostname*. Cloudflare automatically creates a **proxied CNAME** `hms.trustedsystems.co.ke →
   <tunnel-id>.cfargotunnel.com` in your DNS zone. If a DNS record named `hms` already existed, delete it
   first (DNS → Records) and repeat this step.

The tunnel now shows **Inactive / Down** — expected until the container starts in the next step.
You can revisit the configuration any time under *Networks → Tunnels → hms-prod → Configure*.

---

## 7. Step 6 — Build and start the stack

```bash
cd /opt/hms
docker compose config --quiet && echo "compose file OK"     # validates .env substitution
docker compose up -d --build
```

The first build downloads base images and compiles both apps — allow **5–15 minutes** depending on CPU. Then:

```bash
docker compose ps
```

Expected (names may be prefixed `hms-`):

```
NAME               IMAGE                          STATUS
hms-postgres-1     postgres:17-alpine             Up (healthy)
hms-backend-1      hms-backend:latest             Up (healthy)
hms-frontend-1     hms-frontend:latest            Up (healthy)
hms-nginx-1        nginx:1.27-alpine              Up (healthy)
hms-cloudflared-1  cloudflare/cloudflared:latest  Up
hms-db-backup-1    postgres:17-alpine             Up
```

Watch the backend apply its migrations and the tunnel connect:

```bash
docker compose logs -f backend        # …Applied migration 010_stock_movement_journal_link.sql
                                      # HMS backend listening on :4000 (production)    → Ctrl-C
docker compose logs cloudflared       # "Registered tunnel connection" ×4 (two Cloudflare data centres)
```

In the Cloudflare dashboard the tunnel status changes to **Healthy**.

All services have `restart: unless-stopped`, so the stack comes back automatically after a reboot.

---

## 8. Step 7 — Seed the database (first run only)

The seed creates everything the application needs to run and is **idempotent** — re-running it never deletes
or overwrites existing data. Choose one mode:

### Production (recommended) — `SEED_MODE=minimal`

Creates the organisation from the `HOTEL_*` / `COMPANY_*` values, all roles and permissions, the chart of
accounts and posting mappings, taxes (VAT 16 %, Tourism Levy 2 %, zero-rated, exempt), payment methods, units, categories,
approval workflows, the first business day — and **one user, `admin`**, who must change the password at first
login. No demo rooms, guests, menus, products or stock.

```bash
cd /opt/hms
docker compose exec -e ADMIN_PASSWORD='Choose-A-Strong-Passphrase-2026' backend npm run seed:prod
```

`SEED_MODE=minimal` comes from `.env`; the password is passed only for this command (minimum 10 characters).
Expected output ends with `Minimal (production) seed complete`.

### Evaluation / training server — demo data

```bash
docker compose exec -e SEED_MODE=demo backend npm run seed:prod
```

This loads *Demo Hotel & Resort* with rooms, outlets, menus, stock and 18 users who all use the password
`Password123` — **never do this on the live system** for the property.

---

## 9. Step 8 — Verify end to end

```bash
# 1. Inside the server: nginx and the API
curl -s http://127.0.0.1:8080/healthz ; echo                      # ok
curl -s http://127.0.0.1:8080/api/health ; echo                   # {"ok":true,"service":"hms-backend",...}

# 2. Through Cloudflare from anywhere (also try from your phone on mobile data)
curl -sI https://hms.trustedsystems.co.ke/api/health | head -1    # HTTP/2 200
curl -s  https://hms.trustedsystems.co.ke/api/health ; echo

# 3. Login round-trip via the public URL
curl -s -X POST https://hms.trustedsystems.co.ke/api/auth/login \
     -H 'content-type: application/json' \
     -d '{"username":"admin","password":"Choose-A-Strong-Passphrase-2026"}' | head -c 200 ; echo
```

Then open **https://hms.trustedsystems.co.ke** in a browser: the login page must load with a valid
certificate (padlock, issued by Cloudflare). Log in as `admin` — you are taken straight to the *change
password* screen.

Quick checks that the stack is wired correctly:

* Browser dev tools → *Network*: requests go to `/api/...` on the same origin (no CORS errors).
* *Settings → System → Backups → Create backup* produces a file (proves `pg_dump` and the `backups` volume work).
* *Profile* shows your name; *Settings → Audit* already lists your login and password change.

---

## 10. Step 9 — First login and go-live configuration

Do these in order inside the app (all as `admin`, then hand over to departmental users):

| # | Where | What |
|---|---|---|
| 1 | Profile | Change the admin password (forced), set e-mail. |
| 2 | Settings → Properties | Check hotel details, currency, timezone, check-in/out times, service charge, tax mode. |
| 3 | Settings → General | Document numbering (RES-, INV-, PO- prefixes, yearly reset), check-out balance rule, discount/void limits. |
| 4 | Finance → Accounts / Finance → Setup | Review the chart of accounts and posting mappings; adjust taxes, payment methods, currencies and accounting periods. |
| 5 | Settings → Departments / Roles | Adjust role permissions to your policies (the backend enforces them). |
| 6 | Settings → Users | Create real users with strong passwords and *must change password*; keep `admin` for break-glass use only. |
| 7 | Settings → Rooms / Rates | Room types, rooms (with floors and status), rate plans, meal plans, packages, seasonal rates. |
| 8 | POS → Outlets / Menus | Restaurants, bars, club; tables; menus with prices (tax-inclusive) and recipes. |
| 9 | Inventory → Stores / Products | Stores, product catalogue, units, reorder levels; suppliers under Procurement. |
| 10 | Inventory → Stocktakes or Procurement → GRN | Load opening stock (approved stocktake or an opening GRN). |
| 11 | Finance → Journals | Post opening balances (bank, cash, receivables, payables, equity). |
| 12 | Settings → Workflows | Confirm approval thresholds (requisitions, POs, adjustments, expenses). |
| 13 | Settings → Import | Bulk-load guests, products, suppliers, rooms from CSV if migrating. |
| 14 | Finance → Night Audit | Confirm the business date and run the first night audit at the end of day one. |

---

## 11. Step 10 — Recommended Cloudflare settings

In the main dashboard (<https://dash.cloudflare.com> → `trustedsystems.co.ke`):

| Area | Setting | Why |
|---|---|---|
| SSL/TLS → Overview | Encryption mode **Full (strict)** | Tunnel traffic is encrypted regardless; strict mode protects any other records in the zone. |
| SSL/TLS → Edge Certificates | **Always Use HTTPS: On**, **Minimum TLS 1.2**, optional HSTS | Staff links pasted as `http://` are upgraded. |
| Speed → Optimization | **Rocket Loader: Off**, Auto Minify off | Rocket Loader breaks Next.js hydration. |
| Caching → Cache Rules | Rule: hostname `hms.trustedsystems.co.ke` **and** URI path starts with `/api/` or `/uploads/` → **Bypass cache** | Never cache API or attachments. |
| Security → WAF | Enable *Cloudflare Managed Ruleset* (Free managed rules) | Basic exploit filtering. |
| Security → Bots | If you turn on *Bot Fight Mode* and see failed API calls, add a WAF *Skip* rule for `/api/*` | JS challenges cannot be answered by fetch requests. |
| Rules → Rate limiting (optional) | `/api/auth/login` : 20 requests / 10 s per IP → block | Extra brute-force protection at the edge. |

### Optional — put Cloudflare Access in front of the app

If the hotel does not want the login page reachable by the whole internet:

1. <https://one.dash.cloudflare.com> → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: `hms.trustedsystems.co.ke`; session duration 24 h (or longer for POS tablets).
3. Policy *Staff*: Action **Allow**, Include → *Emails ending in* `@trustedsystems.co.ke`
   (or a list of e-mails / a Google Workspace / Microsoft identity provider). Add a **Bypass** policy for the
   hotel's fixed office IP if you have one, so POS terminals are not prompted.
4. Authentication method: One-time PIN (default) — staff receive a code by e-mail, then see the HMS login.

Access adds a second gate; the application's own users, roles and audit trail are unchanged.

---

## 12. Operations: backups, restore, updates, logs

Run everything from `/opt/hms` as user `hms`.

### 12.1 Backups

* **Automatic:** the `db-backup` service runs `pg_dump -Fc` at `BACKUP_CRON` (02:15 daily) and keeps
  `BACKUP_KEEP_DAYS` days in the `backups` volume. Check: `docker compose logs db-backup`.
* **On demand:** *Settings → System → Backups → Create backup* (permission `settings.backup`, audited), or

  ```bash
  docker compose exec db-backup /usr/local/bin/hms-backup
  ```

* **List / copy out of the volume:**

  ```bash
  docker compose exec backend ls -lh /data/backups
  docker compose cp backend:/data/backups/hms-20260922-021500.dump /home/hms/
  ```

* **Off-site copy (do this — a backup on the same disk is not a backup).** Example with rclone to any
  S3/Backblaze/Google Drive remote, run nightly at 03:00 by the host's cron:

  ```bash
  sudo apt-get install -y rclone && rclone config        # create remote "offsite"
  ( crontab -l 2>/dev/null; echo '0 3 * * * docker run --rm -v hms_backups:/b:ro -v /home/hms/.config/rclone:/config/rclone rclone/rclone sync /b offsite:hms-backups >> /home/hms/offsite.log 2>&1' ) | crontab -
  ```

* **Attachments** (`hms_uploads` volume) must be backed up too:

  ```bash
  docker run --rm -v hms_uploads:/u:ro -v /home/hms:/out alpine tar czf /out/hms-uploads-$(date +%F).tgz -C /u .
  ```

* **Test a restore quarterly** on a scratch machine — an untested backup is a hope, not a plan.

### 12.2 Restore the database

```bash
cd /opt/hms
docker compose stop backend frontend db-backup
docker compose cp /home/hms/hms-20260922-021500.dump postgres:/tmp/restore.dump
docker compose exec postgres psql -U hms -d postgres -c "DROP DATABASE hms;" -c "CREATE DATABASE hms OWNER hms;"
docker compose exec postgres pg_restore -U hms -d hms --no-owner --exit-on-error /tmp/restore.dump
docker compose exec postgres rm /tmp/restore.dump
docker compose start backend frontend db-backup     # backend re-applies any newer migrations
```

### 12.3 Update to a new version

```bash
cd /opt/hms
docker compose exec db-backup /usr/local/bin/hms-backup      # safety backup first
git fetch --all --tags && git pull --ff-only                 # or: git checkout v1.1.0
docker compose up -d --build                                 # rebuilds changed images, restarts them
docker compose logs -f backend                               # migrations apply before it accepts traffic
docker image prune -f                                        # free disk from old layers
```

Downtime is the container restart (a few seconds for the API, up to a minute for the frontend). Migrations
are additive; to roll back an application version, `git checkout <previous tag>` and rebuild — restore the
safety backup only if a migration must be undone.

### 12.4 Everyday commands

```bash
docker compose ps                               # health overview
docker compose logs -f --tail=200 backend       # API log (also: frontend, nginx, cloudflared, db-backup)
docker compose restart backend                  # restart one service
docker compose down && docker compose up -d     # full restart (data volumes are kept)
docker compose exec postgres psql -U hms hms    # SQL console
docker system df && df -h /                     # disk usage
```

### 12.5 Monitoring

* Cloudflare notifies you when the tunnel goes down: Zero Trust → *Notifications* (or the main dashboard →
  Notifications → **Tunnel Health Alert**).
* Add a free external uptime monitor (UptimeRobot, Better Stack, Healthchecks.io) on
  `https://hms.trustedsystems.co.ke/api/health` expecting `"ok":true`.
* `docker compose ps` shows `(unhealthy)` when a container's healthcheck fails; `restart: unless-stopped`
  restarts crashed processes automatically.

---

## 13. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Browser shows Cloudflare **Error 1033** ("Argo Tunnel error") | cloudflared is not connected. `docker compose ps` / `docker compose logs cloudflared`. Bad or missing token → fix `CLOUDFLARE_TUNNEL_TOKEN`, `docker compose up -d cloudflared`. |
| Cloudflare **502 Bad Gateway** (Cloudflare-branded page) | Tunnel is up but the origin URL is wrong or nginx is down. Public hostname URL must be `nginx:80` (type HTTP). `docker compose ps nginx`. |
| **502** with an nginx page | nginx is up, frontend or backend is not. `docker compose logs backend` — usually a migration/seed error or a bad `.env` value. |
| `Missing required environment variable DATABASE_URL` / `POSTGRES_PASSWORD … required` | `.env` missing or unreadable (`chmod 600`, owned by `hms`); Compose must run from `/opt/hms`. |
| Tunnel flaps: "failed to dial to edge" / reconnect loops | UDP 7844 (QUIC) blocked by the ISP or router → set `CLOUDFLARE_TUNNEL_PROTOCOL=http2` and `docker compose up -d cloudflared`. Also check clock sync (`timedatectl`). |
| Frontend build dies with `Killed` / exit code 137 | Out of memory. Add the 4 GB swap from section 2.5, or build on a bigger machine and push images to a registry. |
| `permission denied … /var/run/docker.sock` | User not yet in the `docker` group in this session → `newgrp docker` or re-login. |
| `bind: address already in use` for port 8080 | Something else listens on the host port → change `HTTP_PORT` in `.env`. |
| Login returns `RATE_LIMITED` for everyone | Whole property behind one NAT IP hit the per-IP limit → raise `RATE_LIMIT_LOGIN_PER_15MIN` / `RATE_LIMIT_API_PER_MINUTE`, `docker compose up -d backend`. |
| `password authentication failed for user "hms"` after editing `POSTGRES_PASSWORD` | The DB keeps the original password. Either revert the value or run `docker compose exec postgres psql -U hms -d hms -c "ALTER USER hms PASSWORD '<new>';"` **before** restarting the backend. |
| Wrong business date / times off by 3 h | Timezone. `DEFAULT_TIMEZONE=Africa/Nairobi` in `.env`, host `timedatectl`, then check *Finance → Night Audit*. |
| CORS error in the browser console | App opened via a different hostname than `CORS_ORIGINS` (e.g. LAN IP). Add it: `CORS_ORIGINS=https://hms.trustedsystems.co.ke,http://192.168.1.10:8080`. |
| Exports or large reports time out at exactly 100 s | Cloudflare's proxy timeout on the Free plan. Narrow the date range or run the export over the LAN (Appendix A). |
| `docker compose up` warns "Found orphan containers" | You ran Compose without the profiles. Keep `COMPOSE_PROFILES=tunnel,backup` in `.env`. |
| Disk filling up | `docker system prune -f` (dangling images), lower `BACKUP_KEEP_DAYS`, check `docker compose logs --tail=0 db-backup` prunes. |

Collect diagnostics for support in one go:

```bash
cd /opt/hms && { docker compose ps; docker compose logs --tail=200 backend nginx cloudflared; df -h /; free -h; } > /home/hms/hms-diag-$(date +%F).txt 2>&1
```

---

## 14. Security checklist

- [ ] SSH: key-only, root login disabled, UFW allows **only** OpenSSH, fail2ban running.
- [ ] Automatic security updates enabled; Docker Engine updated with `apt` (`docker compose up -d` after a
      Docker upgrade if containers were restarted).
- [ ] `.env` is `chmod 600`, never committed, secrets generated with `openssl rand`.
- [ ] `NODE_ENV=production` (hides stack traces), `CORS_ORIGINS` limited to the real hostname.
- [ ] Seeded with `SEED_MODE=minimal`; the `admin` password was changed at first login; **no demo users** exist
      (*Settings → Users* — if a training server was re-purposed, disable them).
- [ ] Every staff member has a personal account; POS terminals use named cashier users with shifts.
- [ ] Roles reviewed: approval (SoD) permissions such as `inventory.approve_*`, `purchases.approve`,
      `folios.reverse`, `settings.backup` restricted to managers.
- [ ] nginx bound to `127.0.0.1` (`HTTP_BIND`), database not published, only the tunnel reaches the app.
- [ ] Cloudflare: Always Use HTTPS, WAF managed rules, optional Access policy or edge rate limiting.
- [ ] Nightly backups running **and** synced off-site; restore procedure tested; uploads volume included.
- [ ] Tunnel Health Alert and an external uptime monitor configured.
- [ ] Night audit performed daily; audit trail (*Settings → Audit*) reviewed periodically.

---

## 15. Appendix A — LAN access without Cloudflare (or in addition to it)

A hotel usually wants the POS to keep working when the internet is down. Options:

**A. Tunnel + LAN on the same server (recommended).** Publish nginx on the LAN as well:

```dotenv
HTTP_BIND=0.0.0.0
HTTP_PORT=8080
CORS_ORIGINS=https://hms.trustedsystems.co.ke,http://192.168.1.10:8080
```

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp   # LAN only
docker compose up -d
```

Staff use `https://hms.trustedsystems.co.ke` normally and `http://192.168.1.10:8080` as the offline fallback
(plain HTTP inside the building; give the server a DHCP reservation or static IP). Remember Docker publishes
ports around UFW, so the `HTTP_BIND` interface choice is what actually limits exposure.

**B. LAN only, no Cloudflare.** Set `HTTP_BIND=0.0.0.0`, `HTTP_PORT=80`, `CORS_ORIGINS=http://<server-ip>`,
remove `tunnel` from `COMPOSE_PROFILES`, `sudo ufw allow from <lan-cidr> to any port 80 proto tcp`.

**C. Public server with your own TLS.** Put Caddy or Traefik in front of nginx, or add a `listen 443 ssl`
block with your certificates to `deploy/nginx/hms.conf`, open 80/443 in UFW and skip the tunnel.

---

## 16. Appendix B — Environment variable reference

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | — (required) | compose | DB superuser `hms`; applied on first start of the `pgdata` volume. |
| `JWT_SECRET`, `SESSION_SECRET` | — | backend | ≥ 32 random bytes each. Rotating `JWT_SECRET` logs everyone out. |
| `SESSION_TTL_MINUTES` | 480 | backend | Idle session lifetime. |
| `BCRYPT_ROUNDS`, `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES` | 12 / 5 / 15 | backend | Password hashing cost; account lockout policy. |
| `TRUST_PROXY_HOPS` | 1 | backend | Number of reverse proxies (nginx = 1). |
| `RATE_LIMIT_API_PER_MINUTE` | 1200 | backend | Per client IP. |
| `RATE_LIMIT_LOGIN_PER_15MIN` | 100 (prod) | backend | Per client IP on `/api/auth/login`. |
| `NODE_ENV` | production (forced by compose) | backend/frontend | Hides stack traces, strict limits. |
| `CORS_ORIGINS` | `*` | backend | Comma-separated allowed origins — set to the real URL(s). |
| `UPLOAD_MAX_SIZE` | 10485760 | backend | Bytes per attachment (nginx allows 25 MB). |
| `SEED_MODE` | demo | seed | `minimal` for production. |
| `ADMIN_PASSWORD` | — | seed (minimal) | ≥ 10 chars; pass with `exec -e`, do not store. |
| `HOTEL_NAME`, `HOTEL_CODE`, `HOTEL_ADDRESS`, `HOTEL_CITY`, `HOTEL_COUNTRY`, `HOTEL_PHONE`, `HOTEL_EMAIL`, `HOTEL_CURRENCY`, `HOTEL_TIMEZONE`, `SERVICE_CHARGE_PERCENT` | Demo Hotel… | seed (minimal) | Property record; editable later in *Settings → Properties*. |
| `COMPANY_NAME`, `COMPANY_LEGAL_NAME`, `COMPANY_TAX_NUMBER`, `COMPANY_WEBSITE` | Demo… | seed (minimal) | Company record. |
| `DEFAULT_CURRENCY`, `DEFAULT_TIMEZONE`, `DEFAULT_LOCALE` | KES / Africa/Nairobi / en | backend, compose (`TZ`) | Container timezone for all services. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | — | backend | Optional e-mail notifications. |
| `HTTP_BIND`, `HTTP_PORT` | 0.0.0.0 / 80 (compose) — **127.0.0.1 / 8080 in this guide** | compose | Host interface and port nginx is published on. |
| `CLOUDFLARE_TUNNEL_TOKEN` | — (required with `tunnel` profile) | cloudflared | From Zero Trust → Networks → Tunnels. |
| `CLOUDFLARE_TUNNEL_PROTOCOL` | auto | cloudflared | `http2` if QUIC (UDP 7844) is blocked. |
| `BACKUP_CRON`, `BACKUP_KEEP_DAYS` | `15 2 * * *` / 14 | db-backup | Schedule (container timezone) and retention. |
| `COMPOSE_FILE`, `COMPOSE_PROFILES` | — | docker compose | `docker-compose.prod.yml` / `tunnel,backup` so plain `docker compose` targets production. |

---

## 17. Appendix C — Command cheat-sheet

```bash
cd /opt/hms
docker compose up -d --build                 # (re)build + start everything
docker compose ps                            # status / health
docker compose logs -f backend               # follow a service log
docker compose exec -e ADMIN_PASSWORD='…' backend npm run seed:prod     # first-run production seed
docker compose exec -e SEED_MODE=demo backend npm run seed:prod         # demo data (training server only)
docker compose exec db-backup /usr/local/bin/hms-backup                 # manual DB backup
docker compose exec backend ls -lh /data/backups                        # list backups
docker compose cp backend:/data/backups/<file>.dump ~/                  # copy a backup to the host
docker compose exec postgres psql -U hms hms                            # SQL console
git pull --ff-only && docker compose up -d --build && docker image prune -f   # update
docker compose down                          # stop (volumes are kept)
docker compose down -v                       # !!! stop AND DELETE all data volumes
```
