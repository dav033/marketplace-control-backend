# Deploy de Marketplace Control

Push a `main` ejecuta `.github/workflows/deploy.yml`. El workflow empaqueta solo el commit, lo sube por SSH, ejecuta `npm ci` y `npm run build` en EC2, actualiza un symlink `current`, reinicia systemd y recarga Caddy.

## MCP remoto para Claude Web y respaldo SSH

El servicio `marketplace-control-mcp.service` publica el MCP por Streamable HTTP
en `127.0.0.1:4322`. Caddy lo expone por HTTPS en `/mcp` y los endpoints OAuth
en `/.well-known/*` y `/oauth/*`. Claude Web se conecta con:

```text
https://54-167-34-107.sslip.io/mcp
```

La conexión exige OAuth/PKCE y la clave administrativa se introduce solo en la
página de autorización. El fallback de compañía es
`https://marketplace.sempertex.com/mcp`, cuando el DNS esté configurado.

El MCP también conserva el transporte `stdio`. En cada deploy se instala y compila en
`current/mcp-server`, y queda disponible mediante el puente root-only
`/usr/local/bin/marketplace-control-mcp`. El cliente MCP local debe ejecutar
SSH con la clave privada y el usuario de despliegue; usar como plantilla
`deploy/mcp-client-config.example.json` y reemplazar la ruta de la clave.

El puente carga `DATABASE_URL` desde
`/etc/marketplace-control/marketplace-control.env`, que nunca entra al repo ni
se imprime en logs. No se expone un puerto MCP público.

## Desarrollo local con datos de producción

Para ver la aplicación local usando PostgreSQL de EC2 sin publicar el puerto
5432, ejecutar desde PowerShell:

```powershell
.\deploy\dev-production.ps1
```

El script abre un túnel SSH solo en `127.0.0.1:15432`, obtiene la URL protegida
en memoria y arranca Astro en `http://127.0.0.1:4321`. Al cerrar Astro, cierra
el túnel. No crea `.env`, no copia passwords y no expone PostgreSQL a Internet.

## Prerrequisitos de EC2

EC2 debe tener Linux con `node`, `npm`, `caddy`, `systemd` y `sudo` sin contraseña para `DEPLOY_USER`. Ejecutar una vez, manualmente y por SSH:

```bash
sudo bash deploy/bootstrap-host.sh /srv/marketplace-control ec2-user
```

El script no instala credenciales ni modifica AWS. Crea directorios y el archivo externo de entorno:

```text
/etc/marketplace-control/marketplace-control.env
```

Completarlo como `root:root`, permisos `0600`, antes del primer deploy. Mínimo:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4321
DATABASE_URL=postgresql://...
ADMIN_ACCESS_KEY=...
```

No poner este archivo en GitHub ni en el repositorio. El workflow no imprime sus valores.

## DNS y HTTPS

Crear un registro `A`:

```text
marketplace.sempertex.com -> IP pública o Elastic IP de EC2
```

Abrir TCP `80` y `443` en el security group. `deploy/Caddyfile` hace proxy a
`127.0.0.1:4321` y al MCP en `127.0.0.1:4322`; Caddy solicita y renueva
automáticamente los certificados Let's Encrypt cuando DNS ya resuelve y los
puertos son accesibles.

## GitHub Secrets

Configurar exactamente estos secretos del repositorio:

| Secret | Valor |
| --- | --- |
| `DEPLOY_HOST` | DNS o IP de EC2 |
| `DEPLOY_USER` | Usuario Linux con sudo sin contraseña |
| `DEPLOY_SSH_KEY` | Clave privada SSH completa; nunca commitearla |
| `DEPLOY_PATH` | Ruta absoluta, por ejemplo `/srv/marketplace-control` |

Opcional y recomendado: `DEPLOY_KNOWN_HOSTS`, con la línea de host key obtenida desde una máquina confiable. Si falta, el workflow usa `ssh-keyscan` en el runner para la primera conexión.

La clave pública correspondiente debe estar en `~/.ssh/authorized_keys` de EC2. No inventar ni copiar credenciales al workflow.

## Idempotencia, migraciones y rollback

Cada SHA vive en `DEPLOY_PATH/releases/<sha>`. `current` cambia atómicamente solo después de `npm ci`, build, aplicación idempotente de `sql/schema.sql` y validación de Caddy. Si el servicio no queda activo, se intenta restaurar el release anterior. El archivo de entorno permanece fuera del repo.

## Validación local

Desde la raíz del proyecto:

```bash
npm run build
bash -n deploy/bootstrap-host.sh
bash -n deploy/remote-deploy.sh
```

El workflow no hace `git push`, no ejecuta cambios AWS y no requiere credenciales AWS.
