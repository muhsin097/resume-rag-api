# Manual EC2 deploy

How this app actually got deployed -- a single EC2 instance running
Docker Compose (api + web + Postgres/pgvector), launched and configured
by hand via the AWS Console. No Terraform, no CI/CD -- just the steps,
kept here so they're repeatable.

## 1. Launch the instance (AWS Console)

- EC2 -> Launch instance
- Name: `resume-rag-app`
- AMI: Ubuntu Server 24.04 LTS
- Instance type: `t3.micro` (free-tier eligible)
- **Storage: 20 GiB** (the AMI default of 8GB is not enough to build two
  Node apps -- ran out of disk mid-build at 8GB)
- Key pair: create new, download the `.pem`
- Security group: allow SSH (22) from your IP, and a rule for TCP 3001
  from anywhere (the web app's port)

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
```

(Private repos -- if prompted for a password, use a GitHub personal
access token instead, not your account password.)

## 5. Write `.env`

```bash
cd resume-rag-api/deploy
cp .env.example .env
```

Edit `.env` and fill in:
- `DB_PASSWORD`, `JWT_SECRET`, `AUTH_SECRET`: `openssl rand -hex 32` (or similar) for each
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
docker compose up -d
docker compose exec api npx prisma migrate deploy
```

## 7. Verify

```bash
docker compose ps                                                  # all 3 should show "Up"
docker compose exec api node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(console.log)"
curl -s http://localhost:3001/login                                  # should return HTML
```

Then visit `http://<public-ip>:3001` in a browser.

## Redeploying after code changes

```bash
cd ~/resume-rag-api && git pull   # or ~/resume-rag-web
cd ~/resume-rag-api/deploy
docker compose build api    # or web
docker compose up -d
```

## Teardown

EC2 Console -> select the instance -> Instance state -> Terminate.
