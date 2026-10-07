#!/usr/bin/env bash
# HTTPS for the dashboard: Caddy terminates TLS (Let's Encrypt certificate, renewed automatically; TLS
# 1.2/1.3 only, modern ciphers, HSTS) and forwards to the bot on 127.0.0.1:3000. A few MB of memory and
# next to no CPU (one user's dashboard polls).
#
# Address: DASHBOARD_DOMAIN in ~/bot/bot.env (a name you own, pointed at this server), else
# <public-ip-with-dashes>.sslip.io, a free DNS name that resolves to the IP (54.145.7.203 ->
# 54-145-7-203.sslip.io). Needs ports 443 (and 80, for the HTTP->HTTPS redirect and certificate checks)
# open in the Lightsail firewall; until then Caddy keeps retrying and nothing else is affected.
# HTTPS=off in bot.env skips all of this. Run by deploy/activate.sh; never fails the deploy.
set -uo pipefail
ENV=~/bot/bot.env
val() { grep -E "^$1=" "$ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"; }
[ "$(val HTTPS)" = "off" ] && { echo "https: off (HTTPS=off in bot.env)"; exit 0; }

host="$(val DASHBOARD_DOMAIN)"
if [ -z "$host" ]; then
  tok="$(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
  ip="$(curl -s -m 3 ${tok:+-H "X-aws-ec2-metadata-token: $tok"} http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || ip="$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "https: could not find the public IP; skipped"; exit 0; }
  host="${ip//./-}.sslip.io"
fi
port="$(val PORT)"; port="${port:-3000}"

if ! command -v caddy >/dev/null; then
  echo "https: installing Caddy"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null 2>&1 || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null \
    && sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy \
    || { echo "https: Caddy install failed; skipped (the dashboard stays on http://<ip>:$port)"; exit 0; }
fi

conf="$(mktemp)"
cat > "$conf" <<CADDY
# Written by deploy/https.sh (the deploy rewrites it; set DASHBOARD_DOMAIN or HTTPS=off in ~/bot/bot.env).
{
	servers {
		protocols h1 h2
	}
}

$host {
	tls {
		protocols tls1.2 tls1.3
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		-Server
	}
	reverse_proxy 127.0.0.1:$port
}
CADDY
if ! sudo cmp -s "$conf" /etc/caddy/Caddyfile; then
  if caddy validate --config "$conf" --adapter caddyfile >/dev/null 2>&1; then
    sudo cp "$conf" /etc/caddy/Caddyfile
    sudo systemctl enable caddy >/dev/null 2>&1 || true
    sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy || true
    echo "https: Caddy configured for https://$host"
  else
    echo "https: generated Caddyfile did not validate; left the old one"
  fi
else
  sudo systemctl is-active --quiet caddy || sudo systemctl start caddy || true
  echo "https: https://$host (unchanged)"
fi
rm -f "$conf"
exit 0
