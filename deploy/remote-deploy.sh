#!/usr/bin/env bash
set -Eeuo pipefail

# Ejecutado por .github/workflows/deploy.yml vía SSH.
# Argumentos: DEPLOY_PATH en base64, DEPLOY_USER en base64, SHA del commit.

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$#" -eq 3 ]] || fail 'argumentos inválidos'

decode_b64() {
  printf '%s' "$1" | base64 --decode
}

deploy_path="$(decode_b64 "$1")"
app_user="$(decode_b64 "$2")"
release_id="$3"
archive="/tmp/marketplace-control-${release_id}.tar.gz"
env_file="/etc/marketplace-control/marketplace-control.env"
unit_file="/etc/systemd/system/marketplace-control.service"
caddy_file="/etc/caddy/Caddyfile"
mcp_wrapper="/usr/local/bin/marketplace-control-mcp"
mcp_sudoers="/etc/sudoers.d/marketplace-control-mcp"
mcp_unit_file="/etc/systemd/system/marketplace-control-mcp.service"

[[ "$deploy_path" == /* && "$deploy_path" != '/' && "$deploy_path" != *'..'* ]] || fail 'DEPLOY_PATH inválido'
[[ "$deploy_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail 'DEPLOY_PATH contiene caracteres no permitidos'
[[ "$app_user" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail 'DEPLOY_USER inválido'
[[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'
[[ -f "$archive" ]] || fail "release no encontrado: $archive"
id "$app_user" >/dev/null 2>&1 || fail "no existe el usuario $app_user"

for command_name in node npm sudo systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name no está instalado"
done
command -v caddy >/dev/null 2>&1 || fail 'caddy no está instalado; ejecutar bootstrap-host.sh'
sudo -n true >/dev/null 2>&1 || fail 'DEPLOY_USER necesita sudo sin contraseña'

trap 'rm -f -- "$archive"' EXIT

sudo install -d -m 0755 -o "$app_user" -g "$app_user" "$deploy_path"
sudo install -d -m 0755 -o "$app_user" -g "$app_user" "$deploy_path/releases"

release_dir="$deploy_path/releases/$release_id"
if [[ -e "$release_dir" || -L "$release_dir" ]]; then
  rm -rf -- "$release_dir"
fi
install -d -m 0755 -o "$app_user" -g "$app_user" "$release_dir"
tar --extract --gzip --file "$archive" --no-same-owner --directory "$release_dir"

cd "$release_dir"
npm ci --no-audit --no-fund
npm run build
[[ -f "$release_dir/dist/server/entry.mjs" ]] || fail 'Astro no generó dist/server/entry.mjs'

if [[ -f "$release_dir/mcp-server/package-lock.json" ]]; then
  cd "$release_dir/mcp-server"
  npm ci --no-audit --no-fund
  npm run build
  [[ -f "$release_dir/mcp-server/dist/index.js" ]] || fail 'MCP no generó dist/index.js'
  cd "$release_dir"
fi

sudo test -f "$env_file" || fail "falta $env_file; copiar deploy/marketplace-control.env.example y completar valores"
sudo grep -Eq '^DATABASE_URL=[^[:space:]]+$' "$env_file" || fail 'DATABASE_URL vacío o ausente en el archivo externo'
sudo grep -Eq '^ADMIN_ACCESS_KEY=[^[:space:]]+$' "$env_file" || fail 'ADMIN_ACCESS_KEY vacío o ausente en el archivo externo'

# La instalación de marketplace usa PostgreSQL local. El esquema es idempotente
# y se aplica antes de reiniciar la app para que las migraciones de runtime
# acompañen al release.
if [[ -f "$release_dir/sql/schema.sql" ]] && command -v psql >/dev/null 2>&1; then
  sudo -n -u postgres psql --dbname=marketplace --set ON_ERROR_STOP=1 --file="$release_dir/sql/schema.sql" >/dev/null || fail 'no se pudo aplicar sql/schema.sql'
fi

node_bin="$(command -v node)"
sudo install -d -m 0750 -o root -g root /etc/marketplace-control
sudo install -m 0755 -o root -g root "$release_dir/deploy/mcp-stdio.sh" "$mcp_wrapper"
sudo tee "$mcp_sudoers" >/dev/null <<SUDOERS
$app_user ALL=(root) NOPASSWD: $mcp_wrapper ""
SUDOERS
sudo chmod 0440 "$mcp_sudoers"
sudo visudo -cf "$mcp_sudoers" >/dev/null

sudo tee "$unit_file" >/dev/null <<UNIT
[Unit]
Description=Marketplace Control Astro
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$app_user
WorkingDirectory=$deploy_path/current
EnvironmentFile=$env_file
EnvironmentFile=-/etc/marketplace-control/gemini.env
Environment=NODE_ENV=production
ExecStart=$node_bin $deploy_path/current/dist/server/entry.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=full
ReadWritePaths=$deploy_path

[Install]
WantedBy=multi-user.target
UNIT

sudo tee "$mcp_unit_file" >/dev/null <<UNIT
[Unit]
Description=Marketplace Control MCP HTTP
After=network-online.target marketplace-control.service
Wants=network-online.target

[Service]
Type=simple
User=$app_user
WorkingDirectory=$deploy_path/current/mcp-server
EnvironmentFile=$env_file
Environment=MCP_TRANSPORT=http
ExecStart=$node_bin $deploy_path/current/mcp-server/dist/http.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=read-only
ProtectSystem=full
ReadWritePaths=$deploy_path

[Install]
WantedBy=multi-user.target
UNIT

caddy validate --config "$release_dir/deploy/Caddyfile" --adapter caddyfile >/dev/null
if ! id caddy >/dev/null 2>&1; then
  sudo useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
fi
sudo install -d -m 0755 -o caddy -g caddy /etc/caddy /var/lib/caddy /var/log/caddy
sudo install -m 0644 -o root -g root "$release_dir/deploy/caddy.service" /etc/systemd/system/caddy.service
sudo install -d -m 0755 /etc/caddy
sudo install -m 0644 -o root -g root "$release_dir/deploy/Caddyfile" "$caddy_file"

previous_target=''
if [[ -L "$deploy_path/current" ]]; then
  previous_target="$(readlink -f "$deploy_path/current" || true)"
fi
ln -sfn "$release_dir" "$deploy_path/current.next"
mv -Tf "$deploy_path/current.next" "$deploy_path/current"

sudo systemctl daemon-reload
sudo systemctl enable marketplace-control.service >/dev/null
if ! sudo systemctl restart marketplace-control.service || ! sudo systemctl is-active --quiet marketplace-control.service; then
  if [[ -n "$previous_target" && -d "$previous_target" ]]; then
    ln -sfn "$previous_target" "$deploy_path/current.next"
    mv -Tf "$deploy_path/current.next" "$deploy_path/current"
    sudo systemctl restart marketplace-control.service || true
  fi
  fail 'el servicio Astro no quedó activo; se intentó rollback'
fi

sudo systemctl enable marketplace-control-mcp.service >/dev/null
if ! sudo systemctl restart marketplace-control-mcp.service || ! sudo systemctl is-active --quiet marketplace-control-mcp.service; then
  fail 'el servicio MCP HTTP no quedó activo'
fi

sudo systemctl enable --now caddy.service >/dev/null
sudo caddy validate --config "$caddy_file" --adapter caddyfile >/dev/null
sudo systemctl reload caddy.service

printf 'Deploy OK: %s\n' "$release_id"
