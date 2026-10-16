# Manual EC2 deploy

How the backend actually got deployed -- a single EC2 instance running
Docker Compose (api + Postgres/pgvector + Caddy), launched and configured
by hand via the AWS Console.

**`resume-rag-web` and `resume-rag-admin` run on Vercel, not this box.**
They were originally also deployed here via Docker Compose, but the
1GB t3.micro instance couldn't absorb a frontend build running alongside
live production traffic without starving it -- repeated outages during
deploys led to moving both frontends to Vercel, which builds on its own
infra. This instance now only runs the API, its database, and Caddy
(which exposes the API publicly on `api.ceasetoresume.online` for the
Vercel-hosted frontends to call -- see "Domain + HTTPS" below).

**`~/resume-rag-api/deploy/` is the one canonical deploy location on the
instance** -- `.env` and `docker-compose.yml` both live here.

## 1. Launch the instance (AWS Console)

- EC2 -> Launch instance
- Name: `resume-rag-app`
- AMI: Ubuntu Server 24.04 LTS
- Instance type: `t3.micro` (free-tier eligible)
- Storage: 20 GiB
- Key pair: create new, download the `.pem`
- Security group:
  - SSH (22) from anywhere -- needed so GitHub Actions can reach it too;
    key-based auth only (password auth is disabled), so this is the
    actual security boundary
  - TCP 80 and TCP 443 from anywhere -- Caddy (see step 7): 80 for the
    Let's Encrypt HTTP-01 challenge, 443 for the actual API over HTTPS.
    `api` isn't exposed on its own port at all -- Caddy is the only
    public entrypoint

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

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

## 4. Clone the repo

```bash
git clone https://github.com/muhsin097/resume-rag-api.git
```

(Private repo -- if prompted for a password, use a GitHub personal
access token instead, not your account password.)

## 5. Write `.env`

```bash
cd resume-rag-api/deploy
cp .env.example .env
```

Edit `.env` and fill in:
- `DB_PASSWORD`, `JWT_SECRET`: `openssl rand -hex 32` (or similar) for each
- `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`: your real keys

(`AUTH_SECRET`, `ADMIN_AUTH_SECRET`, `GOOGLE_CLIENT_ID`/`SECRET` now live
as Vercel environment variables on the respective frontend projects, not
here.)

## 6. Build and run

```bash
docker compose build api
docker compose up -d
docker compose exec api npx prisma migrate deploy
```

## 7. Domain + HTTPS (Caddy)

`api.ceasetoresume.online` points (A record) at the instance's public IP.
A `caddy` service in `docker-compose.yml` reverse-proxies it to the `api`
container (`deploy/Caddyfile`) and automatically obtains/renews a free
Let's Encrypt certificate -- no certbot, no manual renewal cron.

`ceasetoresume.online` and `admin.ceasetoresume.online` point at Vercel
(CNAME/A records per each Vercel project's Domains settings) -- this box
is never in the request path for either frontend.

## Verify

```bash
docker compose ps                                                  # postgres, api, caddy should show "Up"
curl -s https://api.ceasetoresume.online/users/me                  # 401 (reachable, unauthenticated) confirms it's up
```

## CI/CD

`.github/workflows/deploy.yml` in `resume-rag-api` SSHes into the
instance on every push to `main` (or manual `workflow_dispatch`) and
rebuilds/restarts the `api` service. `resume-rag-web` and
`resume-rag-admin` deploy via Vercel's own GitHub integration instead
(auto-deploys on push to `main`, no SSH involved).

Needs three repo secrets in `resume-rag-api`: `EC2_HOST`,
`EC2_USER` (`ubuntu`), `EC2_SSH_KEY` (the instance's private key).

No AWS API calls involved -- just a direct SSH connection -- so this
isn't affected by account-level AWS permission restrictions.

## Monitoring

CloudWatch agent is installed on the instance, publishing to the
`ResumeRag` namespace: `mem_used_percent`, `swap_used_percent`,
`cpu_usage_idle` (dimension `cpu=cpu-total`), `disk_used_percent`
(dimensions `path=/`, `device=nvme0n1p1`, `fstype=ext4`). Three alarms
(`resume-rag-high-memory`, `resume-rag-high-disk`, `resume-rag-high-swap`,
all >80-85%) notify an SNS topic (`resume-rag-alerts`) with an email
subscription.

Requires an IAM instance profile (`resume-rag-app-instance`, policy
`CloudWatchAgentServerPolicy`) attached to the instance.

## Redeploying after code changes (manual, if not using CI/CD)

```bash
cd ~/resume-rag-api && git pull
cd ~/resume-rag-api/deploy
docker compose build api
docker compose up -d
```

## Teardown

EC2 Console -> select the instance -> Instance state -> Terminate.
(Also delete the `resume-rag-app-instance` IAM role/instance profile
and the `resume-rag-alerts` SNS topic if you want a full clean slate.)
