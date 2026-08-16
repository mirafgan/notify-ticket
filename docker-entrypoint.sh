#!/usr/bin/env bash
set -euo pipefail

# ADY rejects Playwright-launched browser sessions at the ticket API's ReCaptcha
# check. Start Chrome as a normal process and let the Node app attach over CDP.
default_cdp_url='http://127.0.0.1:9222'
cdp_url="${ADY_BROWSER_CDP_URL:-$default_cdp_url}"

# An explicitly configured non-local endpoint is managed outside this container.
if [[ "$cdp_url" != "$default_cdp_url" ]]; then
  exec "$@"
fi

profile_dir="${ADY_BROWSER_PROFILE_DIR:-/data/browser-profile}"
chrome_proxy_server="${ADY_BROWSER_PROXY_SERVER:-}"
mkdir -p "$profile_dir"

chrome_pid=''
xvfb_pid=''
vnc_pid=''
novnc_pid=''
app_pid=''

cleanup() {
  for pid in "$app_pid" "$novnc_pid" "$vnc_pid" "$chrome_pid" "$xvfb_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT
trap 'exit 143' INT TERM

if [[ -z "${DISPLAY:-}" ]]; then
  export DISPLAY=':99'
  Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp &
  xvfb_pid="$!"
fi

chrome_proxy_args=()
if [[ -n "$chrome_proxy_server" ]]; then
  chrome_proxy_args=("--proxy-server=$chrome_proxy_server")
fi

google-chrome-stable \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --user-data-dir="$profile_dir" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --no-sandbox \
  --window-size=1280,720 \
  "${chrome_proxy_args[@]}" \
  > /tmp/ady-chrome.log 2>&1 &
chrome_pid="$!"

for _ in {1..30}; do
  if curl --fail --silent "$default_cdp_url/json/version" >/dev/null; then
    break
  fi

  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    cat /tmp/ady-chrome.log >&2 || true
    exit 1
  fi

  sleep 1
done

if ! curl --fail --silent --show-error "$default_cdp_url/json/version" >/dev/null; then
  echo 'Chrome CDP endpoint did not start within 30 seconds.' >&2
  cat /tmp/ady-chrome.log >&2 || true
  exit 1
fi

x11vnc \
  -display "$DISPLAY" \
  -localhost \
  -forever \
  -shared \
  -nopw \
  -rfbport 5900 \
  > /tmp/ady-vnc.log 2>&1 &
vnc_pid="$!"

/usr/share/novnc/utils/novnc_proxy \
  --listen 6080 \
  --vnc 127.0.0.1:5900 \
  > /tmp/ady-novnc.log 2>&1 &
novnc_pid="$!"

for _ in {1..15}; do
  if curl --fail --silent http://127.0.0.1:6080/vnc.html >/dev/null; then
    break
  fi

  if ! kill -0 "$novnc_pid" 2>/dev/null; then
    echo 'noVNC process stopped before the endpoint became ready.' >&2
    cat /tmp/ady-novnc.log >&2 || true
    exit 1
  fi

  sleep 1
done

if ! curl --fail --silent --show-error http://127.0.0.1:6080/vnc.html >/dev/null; then
  echo 'noVNC endpoint did not start.' >&2
  cat /tmp/ady-vnc.log >&2 || true
  cat /tmp/ady-novnc.log >&2 || true
  exit 1
fi

export ADY_BROWSER_CDP_URL="$default_cdp_url"
echo "Normal Chrome started; bot will connect through $ADY_BROWSER_CDP_URL. noVNC is available on port 6080."
"$@" &
app_pid="$!"

set +e
wait "$app_pid"
app_status="$?"
set -e
exit "$app_status"
