#!/usr/bin/env bash
# Repository-owned, auditable WARP setup for the ephemeral GitHub runner.
#
# Do not replace this with a marketplace action in the secret-bearing crawl job:
# an action can leave a background process behind and observe later step secrets.
# This script installs only Ubuntu-archive networking tools, writes a fixed
# consumer-WARP WireGuard profile from one step-scoped secret, starts the kernel
# tunnel, and exits before the law.go.kr API credential is injected into the
# crawler step.

set -Eeuo pipefail

: "${WARP_PRIVATE_KEY:?WARP_PRIVATE_KEY secret is required}"
if [[ ! "${WARP_PRIVATE_KEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo "WARP_PRIVATE_KEY has an invalid WireGuard key shape" >&2
  exit 1
fi

required_commands=(wg wg-quick resolvconf)
missing_command=false
for command_name in "${required_commands[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    missing_command=true
  fi
done

if [[ "${missing_command}" == "true" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update
  sudo apt-get install --yes --no-install-recommends \
    iproute2 resolvconf wireguard-tools
fi

runner_ipv4="$(
  ip -4 route get 192.168.193.10 |
    awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
)"
if [[ ! "${runner_ipv4}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Unable to determine the runner source address" >&2
  exit 1
fi

config_path="$(mktemp)"
trap 'rm -f "${config_path}"' EXIT
chmod 600 "${config_path}"

# This fixed consumer-WARP identity grants no project access. Its private key is
# supplied only to this step as a GitHub secret; API/R2/Telegram credentials are
# never available to this script. Endpoint roaming, rate limits, or revocation can
# still cause crawler outages. README documents the residual availability risk.
cat >"${config_path}" <<EOF
[Interface]
PrivateKey = ${WARP_PRIVATE_KEY}
Address = 172.16.0.2/32
Address = fd01:5ca1:ab1e:823e:e094:eb1c:ff87:1fab/128
DNS = 1.1.1.1, 8.8.8.8, 8.8.4.4, 2606:4700:4700::1111, 2001:4860:4860::8888, 2001:4860:4860::8844
MTU = 1280
PostUp = ip -4 rule add from ${runner_ipv4} lookup main
PostDown = ip -4 rule delete from ${runner_ipv4} lookup main

[Peer]
PublicKey = bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=
AllowedIPs = 0.0.0.0/0
AllowedIPs = ::/0
Endpoint = engage.cloudflareclient.com:2408
EOF
unset WARP_PRIVATE_KEY

sudo install -d -m 0755 /etc/wireguard
sudo install -m 0600 "${config_path}" /etc/wireguard/bupgogae-warp.conf
sudo wg-quick up bupgogae-warp

warp_status="$(
  curl --fail --silent --show-error --max-time 15 \
    https://www.cloudflare.com/cdn-cgi/trace |
    awk -F= '$1 == "warp" { print $2; exit }'
)"
if [[ "${warp_status}" != "on" && "${warp_status}" != "plus" ]]; then
  echo "WARP route verification failed" >&2
  exit 1
fi

echo "WARP route verified"
