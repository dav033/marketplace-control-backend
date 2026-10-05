#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$#" -eq 3 ]] || fail 'argumentos invalidos'

decode_b64() { printf '%s' "$1" | base64 --decode; }
deploy_path="$(decode_b64 "$1")"
app_user="$(decode_b64 "$2")"
release_id="$3"
archive="/tmp/marketplace-control-${release_id}.tar.gz"
env_file="/etc/marketplace-control/marketplace-control.env"

[[ "$deploy_path" == "/srv/marketplace-control" ]] || fail 'DEPLOY_PATH invalido'
[[ "$app_user" == "ec2-user" ]] || fail 'DEPLOY_USER invalido'
[[ "$release_id" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA invalido'
[[ -f "$archive" ]] || fail "release no encontrado: $archive"
for command_name in node npm sudo systemctl curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name no esta instalado"
done
sudo -n true >/dev/null 2>&1 || fail 'ec2-user necesita sudo sin contrasena'
sudo test -s "$env_file" || fail "falta $env_file"
sudo grep -Eq '^DATABASE_URL=[^[:space:]]+$' "$env_file" || fail 'DATABASE_URL ausente'
sudo grep -Eq '^ADMIN_ACCESS_KEY=[^[:space:]]+$' "$env_file" || fail 'ADMIN_ACCESS_KEY ausente'
sudo test -f /etc/systemd/system/marketplace-control.service || fail 'falta marketplace-control.service'

trap 'rm -f -- "$archive"' EXIT
sudo install -d -m 0755 -o "$app_user" -g "$app_user" "$deploy_path" "$deploy_path/releases"
release_dir="$deploy_path/releases/$release_id"
previous_target="$(readlink -f "$deploy_path/current" 2>/dev/null || true)"
if [[ "$previous_target" == "$release_dir" ]]; then
  curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4321/ >/dev/null || fail 'release activo no responde'
  printf 'Deploy ya activo: %s\n' "$release_id"
  exit 0
fi
if [[ -e "$release_dir" || -L "$release_dir" ]]; then rm -rf -- "$release_dir"; fi
install -d -m 0755 -o "$app_user" -g "$app_user" "$release_dir"
tar --extract --gzip --file "$archive" --no-same-owner --directory "$release_dir"
chown -R "$app_user:$app_user" "$release_dir"

cd "$release_dir"
npm ci --no-audit --no-fund
npm run build
[[ -f "$release_dir/dist/server/entry.mjs" ]] || fail 'Astro no genero dist/server/entry.mjs'

# El esquema contiene CREATE TABLE IF NOT EXISTS y cambios aditivos idempotentes.
if [[ -f "$release_dir/sql/schema.sql" ]] && command -v psql >/dev/null 2>&1; then
  sudo -n -u postgres psql --dbname=marketplace --set ON_ERROR_STOP=1 --file="$release_dir/sql/schema.sql" >/dev/null || fail 'no se pudo aplicar sql/schema.sql'
fi

ln -sfn "$release_dir" "$deploy_path/current.next"
mv -Tf "$deploy_path/current.next" "$deploy_path/current"
if ! sudo systemctl restart marketplace-control.service || \
   ! sudo systemctl is-active --quiet marketplace-control.service || \
   ! curl --fail --silent --show-error --max-time 15 http://127.0.0.1:4321/ >/dev/null; then
  if [[ -n "$previous_target" && -d "$previous_target" ]]; then
    ln -sfn "$previous_target" "$deploy_path/current.next"
    mv -Tf "$deploy_path/current.next" "$deploy_path/current"
    sudo systemctl restart marketplace-control.service || true
  fi
  fail 'Marketplace no paso la verificacion; se intento rollback'
fi
printf 'Deploy OK: %s\n' "$release_id"