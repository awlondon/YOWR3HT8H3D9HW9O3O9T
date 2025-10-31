#!/usr/bin/env bash
# Run npm scripts without triggering warnings from deprecated proxy environment
# variables. The wrapper clears legacy settings and forwards the standard
# HTTP(S)_PROXY values instead.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <npm-script> [-- <arguments>...]" >&2
  exit 1
fi

script_name=$1
shift || true

# Prepare clean environment overriding deprecated variables.
clean_env=(
  "npm_config_http_proxy="
  "npm_config_https_proxy="
  "NPM_CONFIG_HTTP_PROXY="
  "NPM_CONFIG_HTTPS_PROXY="
)

proxy_value="${HTTP_PROXY:-${http_proxy:-}}"
https_proxy_value="${HTTPS_PROXY:-${https_proxy:-$proxy_value}}"

if [[ -n "$proxy_value" ]]; then
  clean_env+=("npm_config_proxy=$proxy_value")
fi
if [[ -n "$https_proxy_value" ]]; then
  clean_env+=("npm_config_https_proxy=$https_proxy_value")
fi

if [[ ${#clean_env[@]} -gt 0 ]]; then
  exec env "${clean_env[@]}" npm run "$script_name" "$@"
else
  exec npm run "$script_name" "$@"
fi
