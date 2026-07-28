#!/usr/bin/env bash
# Install and connect the official Cloudflare consumer WARP client on an
# ephemeral Ubuntu 24.04 GitHub-hosted runner.
#
# This script intentionally has no project credential. The package URL, version,
# architecture, and SHA-256 are content-locked. The crawl step injects only the
# law.go.kr API key after this script has verified the WARP route. The SHA-pinned
# official Cloudflare daemon remains part of that job's trusted computing base
# until the workflow disconnects and stops it immediately after crawling.

set -Eeuo pipefail

readonly WARP_PACKAGE_VERSION="2026.6.880.0"
readonly WARP_PACKAGE_SHA256="648a7c7e9085f8e50d32a2adcacb0c2049fb72ebeb02ebe913becadee3ab0d4c"
readonly WARP_PACKAGE_URL="https://pkg.cloudflareclient.com/pool/noble/main/c/cloudflare-warp/cloudflare-warp_${WARP_PACKAGE_VERSION}_amd64.deb"
readonly WARP_TRACE_URL="https://www.cloudflare.com/cdn-cgi/trace"
readonly WARP_ROUTE_MODE="${WARP_ROUTE_MODE:-full}"

if [[ "${CLOUDFLARE_WARP_TOS_ACCEPTED:-}" != "true" ]]; then
  cat >&2 <<'EOF'
Cloudflare WARP terms have not been acknowledged for this repository.
An authorized repository owner must review:
  https://www.cloudflare.com/application/terms/
Then set the non-secret GitHub Actions repository variable:
  CLOUDFLARE_WARP_TOS_ACCEPTED=true
EOF
  exit 2
fi
if [[ "${WARP_ROUTE_MODE}" != "full" && "${WARP_ROUTE_MODE}" != "proxy" ]]; then
  echo "WARP_ROUTE_MODE must be 'full' or 'proxy'" >&2
  exit 1
fi

# Keep the package pin aligned with the supported, explicitly pinned runner.
# Refuse silent fallback to a different distro or architecture.
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_CODENAME:-}" != "noble" ]]; then
  echo "Official WARP setup requires Ubuntu 24.04 (noble)" >&2
  exit 1
fi
if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "Official WARP package pin requires amd64" >&2
  exit 1
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "${temp_dir}"' EXIT
package_path="${temp_dir}/cloudflare-warp.deb"

sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
  apt-get install --yes --no-install-recommends ca-certificates curl

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --proto '=https' \
  --tlsv1.2 \
  --retry 3 \
  --retry-all-errors \
  --connect-timeout 15 \
  --max-time 180 \
  --output "${package_path}" \
  "${WARP_PACKAGE_URL}"

printf '%s  %s\n' "${WARP_PACKAGE_SHA256}" "${package_path}" |
  sha256sum --check --strict -

sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
  apt-get install --yes --no-install-recommends "${package_path}"
installed_version="$(dpkg-query -W -f='${Version}' cloudflare-warp)"
if [[ "${installed_version}" != "${WARP_PACKAGE_VERSION}" ]]; then
  echo "Unexpected cloudflare-warp version: ${installed_version}" >&2
  exit 1
fi

# The GUI service is unnecessary on a headless runner.
systemctl --user disable --now warp-taskbar.service >/dev/null 2>&1 || true
sudo systemctl start warp-svc.service
service_ready=false
for _ in {1..30}; do
  if systemctl is-active --quiet warp-svc.service &&
    [[ -S /run/cloudflare-warp/warp_service ]]
  then
    service_ready=true
    break
  fi
  sleep 1
done
if [[ "${service_ready}" != "true" ]]; then
  echo "warp-svc did not become active" >&2
  exit 1
fi

# Registration is anonymous consumer registration. It creates an ephemeral
# device identity on the runner; no reusable WARP key or Cloudflare account
# credential is supplied by GitHub Actions.
registered=false
for _ in {1..3}; do
  if timeout --kill-after=5s 15s \
    warp-cli --accept-tos --no-ansi --ipc-timeout 20 \
      registration show >/dev/null 2>&1
  then
    registered=true
    break
  fi
  if timeout --kill-after=5s 45s \
    warp-cli --accept-tos --no-ansi --ipc-timeout 20 \
      registration new >/dev/null 2>&1
  then
    registered=true
    break
  fi
  sleep 2
done
if [[ "${registered}" != "true" ]]; then
  echo "WARP consumer registration failed" >&2
  exit 1
fi

timeout --kill-after=5s 15s \
  warp-cli --accept-tos --no-ansi --ipc-timeout 20 \
    tunnel protocol set MASQUE >/dev/null
if [[ "${WARP_ROUTE_MODE}" == "proxy" ]]; then
  timeout --kill-after=5s 15s \
    warp-cli --accept-tos --no-ansi --ipc-timeout 20 \
      proxy port 40000 >/dev/null
  timeout --kill-after=5s 15s \
    warp-cli --accept-tos --no-ansi --ipc-timeout 20 \
      mode proxy >/dev/null
else
  timeout --kill-after=5s 15s \
    warp-cli --accept-tos --no-ansi --ipc-timeout 20 \
      mode warp+doh >/dev/null
fi
timeout --kill-after=5s 30s \
  warp-cli --accept-tos --no-ansi --ipc-timeout 20 connect >/dev/null

route_verified=false
for _ in {1..30}; do
  proxy_args=()
  if [[ "${WARP_ROUTE_MODE}" == "proxy" ]]; then
    proxy_args=(--noproxy '' --proxy socks5h://127.0.0.1:40000)
  fi
  warp_status="$(
    curl \
      --fail \
      --silent \
      --show-error \
      --proto '=https' \
      --tlsv1.2 \
      --connect-timeout 5 \
      --max-time 10 \
      "${proxy_args[@]}" \
      "${WARP_TRACE_URL}" 2>/dev/null |
      awk -F= '$1 == "warp" { print $2; exit }' ||
      true
  )"
  if [[ "${warp_status}" == "on" || "${warp_status}" == "plus" ]]; then
    route_verified=true
    break
  fi
  sleep 2
done
if [[ "${route_verified}" != "true" ]]; then
  echo "WARP route verification failed" >&2
  exit 1
fi

echo "Official Cloudflare WARP ${WARP_ROUTE_MODE} route verified"
