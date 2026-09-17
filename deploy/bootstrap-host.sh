#!/usr/bin/env bash
set -Eeuo pipefail

# Prepara una EC2 ya provisionada. No instala credenciales ni toca AWS.
# Uso: sudo bash bootstrap-host.sh [/srv/marketplace-control] [usuario-ssh]

app_root="${1:-/srv/marketplace-control}"
app_user="${2:-${SUDO_USER:-ec2-user}}"
env_file="/etc/marketplace-control/marketplace-control.env"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail 'ejecutar como root o con sudo'
[[ "$app_root" == /* && "$app_root" != '/' && "$app_root" != *'..'* ]] || fail 'APP_ROOT debe ser ruta absoluta segura'
[[ "$app_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail 'APP_ROOT solo puede contener letras, números, punto, guion y /'
[[ "$app_user" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || fail 'usuario SSH inválido'
id "$app_user" >/dev/null 2>&1 || fail "no existe el usuario $app_user"

for command_name in node npm caddy systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name no está instalado; instalarlo antes de continuar"
done

if ! id caddy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
fi
install -d -m 0755 -o caddy -g caddy /etc/caddy /var/lib/caddy /var/log/caddy
install -m 0644 -o root -g root "$(dirname "$0")/Caddyfile" /etc/caddy/Caddyfile
install -m 0644 -o root -g root "$(dirname "$0")/caddy.service" /etc/systemd/system/caddy.service
systemctl daemon-reload
systemctl enable caddy.service >/dev/null

install -d -m 0755 -o "$app_user" -g "$app_user" "$app_root"
install -d -m 0755 -o "$app_user" -g "$app_user" "$app_root/releases"
install -d -m 0750 -o root -g root /etc/marketplace-control

if [[ ! -e "$env_file" ]]; then
  install -m 0600 -o root -g root /dev/null "$env_file"
  cat > "$env_file" <<'ENV'
# Completar manualmente. No guardar secretos en Git.
NODE_ENV=production
HOST=127.0.0.1
PORT=4321
DATABASE_URL=
ADMIN_ACCESS_KEY=
ENV
  printf 'Creado %s. Completar DATABASE_URL y ADMIN_ACCESS_KEY antes del primer deploy.\n' "$env_file"
else
  chmod 0600 "$env_file"
  chown root:root "$env_file"
fi

printf 'Host listo: %s\n' "$app_root"
