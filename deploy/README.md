# Manual EC2 deploy

How this app actually got deployed -- a single EC2 instance running
Docker Compose (api + web + admin + Postgres/pgvector), launched and
configured by hand via the AWS Console.

**`~/resume-rag-api/deploy/` is the one canonical deploy location on the
instance** -- `.env` and `docker-compose.yml` both live here. (Earlier
this ran from a separate standalone `~/deploy/` folder; consolidated to
this one so CI/CD and manual commands target the same place.)

## 1. Launch the instance (AWS Console)

- EC2 -> Launch instance
- Name: `resume-rag-app`
- AMI: Ubuntu Server 24.04 LTS
- Instance type: `t3.micro` (free-tier eligible)
- **Storage: 20 GiB** (the AMI default of 8GB is not enough to build two
  Node apps -- ran out of disk mid-build at 8GB)
- Key pair: create new, download the `.pem`
- Security group:
  - SSH (22) from anywhere -- needed so GitHub Actions can reach it too;
    key-based auth only (password auth is disabled), so this is the
    actual security boundary
  - TCP 3001 from anywhere (the web app's port) -- kept as a fallback
    alongside 80/443 below during the move to the custom domain;
    remove once HTTPS is confirmed stable
  - TCP 3002 from anywhere (the admin app's port) -- the admin app has
    its own login gate (only accounts with `is_admin = true` can sign
    in, see step 8), so this is deliberately not restricted by IP;
    same fallback note as 3001
  - TCP 80 and TCP 443 from anywhere -- Caddy (see step 9): 80 for the
    Let's Encrypt HTTP-01 challenge, 443 for the actual site over HTTPS

## 2. SSH in and install Docker

```bash
chmod 400 ~/Downloads/resume-rag-ec2.pem
ssh -i ~/Downloads/resume-rag-ec2.pem ubuntu@<public-ip>

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
# ssh back in so the group change takes effect
```

## 3. Add swap space (t3.micro only has 1GB RAM)

Building two Node apps at once can OOM a 1GB instance and kill the SSH
session along with it. Swap gives enough headroom for the build:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## 4. Clone the repos (as siblings)

```bash
git clone https://github.com/muhsin097/resume-rag-api.git
git clone https://github.com/muhsin097/resume-rag-web.git
git clone https://github.com/muhsin097/resume-rag-admin.git
```

(Private repos -- if prompted for a password, use a GitHub personal
access token instead, not your account password.)

## 5. Write `.env`

```bash
cd resume-rag-api/deploy
cp .env.example .env
```

Edit `.env` and fill in:
- `DB_PASSWORD`, `JWT_SECRET`, `AUTH_SECRET`, `ADMIN_AUTH_SECRET`: `openssl rand -hex 32` (or similar) for each -- `AUTH_SECRET` and `ADMIN_AUTH_SECRET` must be different (two separate NextAuth apps/cookies)
- `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`: your real keys
- `PUBLIC_IP`: **the instance's public IP, typed literally** -- don't
  rely on the EC2 metadata service for this; it requires an IMDSv2
  token and a plain `curl` against it silently returns empty, producing
  a broken `http://:3001` URL that crashes the web app at runtime

## 6. Build and run

Build one service at a time rather than `docker compose up --build`
(which builds everything in parallel and is what triggered the OOM):

```bash
docker compose build api
docker compose build web
docker compose build admin
docker compose up -d
docker compose exec api npx prisma migrate deploy
```

## 7. Verify

```bash
docker compose ps                                                  # all 4 should show "Up"
docker compose exec api node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
curl -s http://localhost:3001/login                                  # should return HTML
curl -s http://localhost:3002/login                                  # should return HTML
```

Then visit `http://<public-ip>:3001` (candidate app) or
`http://<public-ip>:3002` (admin dashboard) in a browser.

## 8. Grant admin access

The admin app (`resume-rag-admin`) shares the same `users` table and
`/auth/login` endpoint as the candidate app -- access is gated purely by
an `is_admin` column, flipped by hand (never via a seed script or any
user-facing endpoint):

```bash
docker compose exec postgres psql -U resumerag -d resumerag \
  -c "UPDATE users SET is_admin = true WHERE email = 'you@example.com';"
```

## 9. Domain + HTTPS (Caddy)

`ceasetoresume.online` and `admin.ceasetoresume.online` both point (A
records) at the instance's public IP. A `caddy` service in
`docker-compose.yml` reverse-proxies each hostname to the right
container (`deploy/Caddyfile`) and automatically obtains/renews a free
Let's Encrypt certificate for both -- no certbot, no manual renewal
cron. `AUTH_URL`/`WEB_ORIGIN` across all three app services point at
the HTTPS domain rather than `http://${PUBLIC_IP}:300x`.

`web`/`admin` still publish 3001/3002 directly as a fallback during
the cutover. Once `https://ceasetoresume.online` and
`https://admin.ceasetoresume.online` are both confirmed working:
remove those `ports:` entries from `docker-compose.yml`, `docker
compose up -d`, then close 3001/3002 in the security group (leave 80
+ 443 open, plus 22 for SSH).

## CI/CD

`.github/workflows/deploy.yml` in `resume-rag-api`, `resume-rag-web`,
and `resume-rag-admin` SSHes into the instance on every push to `main`
(or manual `workflow_dispatch`) and rebuilds/restarts just that one
service. Needs three repo secrets in each repo: `EC2_HOST`,
`EC2_USER` (`ubuntu`), `EC2_SSH_KEY` (the instance's private key).

No AWS API calls involved -- just a direct SSH connection -- so this
isn't affected by account-level AWS permission restrictions.

`.github/workflows/healthcheck.yml` pings `/login` every 15 minutes as
a free app-level uptime check (GitHub emails on failure).

## Monitoring

CloudWatch agent is installed on the instance, publishing to the
`ResumeRag` namespace: `mem_used_percent`, `swap_used_percent`,
`cpu_usage_idle` (dimension `cpu=cpu-total`), `disk_used_percent`
(dimensions `path=/`, `device=nvme0n1p1`, `fstype=ext4`). Three alarms
(`resume-rag-high-memory`, `resume-rag-high-disk`, `resume-rag-high-swap`,
all >80-85%) notify an SNS topic (`resume-rag-alerts`) with an email
subscription -- directly covers the two failure modes already hit
during setup (OOM, disk full).

Requires an IAM instance profile (`resume-rag-app-instance`, policy
`CloudWatchAgentServerPolicy`) attached to the instance.

## Redeploying after code changes (manual, if not using CI/CD)

```bash
cd ~/resume-rag-api && git pull   # or ~/resume-rag-web, ~/resume-rag-admin
cd ~/resume-rag-api/deploy
docker compose build api    # or web / admin
docker compose up -d
```

## Teardown

EC2 Console -> select the instance -> Instance state -> Terminate.
(Also delete the `resume-rag-app-instance` IAM role/instance profile
and the `resume-rag-alerts` SNS topic if you want a full clean slate.)
