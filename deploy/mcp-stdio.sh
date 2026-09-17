#!/usr/bin/env bash
set -Eeuo pipefail

# Puente stdio para clientes MCP. Se ejecuta por SSH y conserva stdin/stdout
# exclusivamente para el protocolo MCP; los diagnósticos van a stderr.
app_root="${MARKETPLACE_CONTROL_ROOT:-/srv/marketplace-control}"
env_file="/etc/marketplace-control/marketplace-control.env"
node_bin="${NODE_BIN:-/usr/local/bin/node}"
mcp_entry="$app_root/current/mcp-server/dist/index.js"

[[ -f "$env_file" ]] || { printf 'ERROR: falta %s\n' "$env_file" >&2; exit 1; }
[[ -f "$mcp_entry" ]] || { printf 'ERROR: falta %s\n' "$mcp_entry" >&2; exit 1; }

set -a
# El archivo es root-only y lo instala el deploy; no imprimir sus valores.
. "$env_file"
set +a

exec "$node_bin" "$mcp_entry"
