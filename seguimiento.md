# Seguimiento ejecutivo — Marketplace Control

**Fecha:** 2026-09-17  
**Repositorio:** https://github.com/dav033/proovedores  
**Rama operativa:** `main`  
**Workspace local:** `C:\Users\davidt\Desktop\marketplace-control`

## 1. Objetivo del proyecto

Se construyó una aplicación Astro para controlar proveedores potenciales:

- proveedores extraídos en una primera etapa;
- revisión y estados del pipeline;
- campañas de correo;
- clics e interés de destinatarios;
- formularios de registro enviados por proveedores;
- seguimiento de contactos y actividad.

La aplicación incluye panel, proveedores, campañas, formularios y configuración.
La base PostgreSQL es la fuente de datos de operación.

## 2. Infraestructura AWS

### EC2

- Instance ID: `i-03111ef004cae5808`
- Tipo: `t4g.medium`
- Arquitectura: ARM64
- Sistema: Amazon Linux 2023
- IP pública: `54.167.34.107`
- IP privada: `172.31.28.121`
- Security Group: `sg-049ddaa191ef6481e`
- Usuario SSH: `ec2-user`
- Clave local: `C:\Users\davidt\.ssh\marketplace-aws`
- Ruta de releases: `/srv/marketplace-control/releases/`
- Symlink activo: `/srv/marketplace-control/current`

### Software del servidor

- Node.js `v22.20.0`
- npm `10.9.3`
- Caddy `v2.11.4`
- PostgreSQL `16.15`
- Servicio Astro: `marketplace-control.service`
- Servicio Caddy: `caddy.service`

### PostgreSQL

- Base: `marketplace`
- Rol de aplicación: `marketplace_control`
- Configuración protegida: `/etc/marketplace-control/marketplace-control.env`
- Permisos del archivo de entorno: `0600`, propietario `root:root`
- PostgreSQL permanece en el servidor; no se abrió un puerto público para la conexión local.

Snapshot observado mediante estadísticas de PostgreSQL, sin leer datos personales:

```text
marketplace.contacts: 9
marketplace.provider_sources: 25
marketplace.providers: 25
marketplace.audit_log: 0
marketplace.campaign_sends: 0
marketplace.campaigns: 0
marketplace.email_clicks: 0
marketplace.registration_submissions: 0
```

Estos conteos son una referencia de `pg_stat_user_tables`; confirmar conteos exactos antes de una operación destructiva.

## 3. Aplicación y despliegue

El despliegue está automatizado en:

- Workflow: `.github/workflows/deploy.yml`
- Script remoto: `deploy/remote-deploy.sh`
- Preparación inicial del host: `deploy/bootstrap-host.sh`
- Configuración Caddy: `deploy/Caddyfile`
- Unidad Caddy: `deploy/caddy.service`
- Entorno de ejemplo, sin secretos: `deploy/marketplace-control.env.example`

Comportamiento decidido:

1. Cada push a `main` dispara GitHub Actions.
2. GitHub empaqueta el commit exacto y lo sube por SSH.
3. EC2 crea una release con el SHA del commit.
4. Ejecuta `npm ci` y `npm run build` de Astro.
5. Compila también `mcp-server`.
6. Cambia atómicamente `/srv/marketplace-control/current`.
7. Reinicia el servicio Astro.
8. Valida y recarga Caddy.
9. Si Astro falla, intenta rollback a la release anterior.

Secrets configurados en GitHub Actions — solo nombres, nunca valores:

- `DEPLOY_HOST`
- `DEPLOY_PATH`
- `DEPLOY_SSH_KEY`
- `DEPLOY_USER`
- `DEPLOY_KNOWN_HOSTS`

La autenticación GitHub CLI se completó con passkey para el usuario `dav033`.

Última release validada:

- Commit: `09cb5945fd8051b575ca27beebe14622ba5790be`
- Acción: run `35280798134`
- Resultado: exitoso
- Servicio Astro: activo
- Health: `http://127.0.0.1:4321/api/health` devuelve `{"ok":true,"service":"marketplace-control"}`

## 4. Dominio, Caddy y HTTPS

Caddy está configurado para:

```text
marketplace.sempertex.com -> 127.0.0.1:4321
```

Archivo remoto: `/etc/caddy/Caddyfile`  
Archivo versionado: `deploy/Caddyfile`

HTTP redirige a HTTPS y Caddy está preparado para solicitar Let’s Encrypt automáticamente.

Pendiente externo: DNS todavía devuelve `NXDOMAIN`. Crear en el proveedor DNS:

```text
Tipo: A
Host: marketplace
Valor: 54.167.34.107
```

Después de la propagación DNS, validar:

```text
https://marketplace.sempertex.com
```

Puertos habilitados en el Security Group:

- TCP 80 desde Internet, para HTTP/validación ACME.
- TCP 443 desde Internet, para HTTPS.
- TCP 22 desde Internet, necesario temporalmente para GitHub-hosted runners.

Decisión de seguridad: no abrir TCP 5432 públicamente. Más adelante se recomienda sustituir SSH público para deploy por runner privado o AWS Systems Manager/SSM.

## 5. MCP

Ubicación del código:

- `mcp-server/src/index.ts`
- `mcp-server/package.json`
- `mcp-server/package-lock.json`
- `mcp-server/scripts/smoke.mjs`
- `mcp-server/README.md`

Herramientas MCP disponibles, todas de solo lectura:

- `search_providers`
- `get_provider`
- `pipeline_stats`
- `list_registration_submissions`

Decisión de arquitectura: transporte `stdio` por SSH, no endpoint HTTP público.
Motivos: no abrir otro puerto, reutilizar SSH, mantener PostgreSQL privado y evitar implementar autenticación HTTP adicional.

Configuración remota:

- Entrada compilada: `/srv/marketplace-control/current/mcp-server/dist/index.js`
- Wrapper: `/usr/local/bin/marketplace-control-mcp`
- Entorno usado: `/etc/marketplace-control/marketplace-control.env`
- Regla sudo restringida: `/etc/sudoers.d/marketplace-control-mcp`

Plantilla de cliente:

- `deploy/mcp-client-config.example.json`

El handshake MCP se validó realmente por SSH y devolvió las cuatro herramientas. No se imprimieron credenciales ni registros de base de datos.

## 6. Uso local con datos de producción

La URL `http://127.0.0.1:4321` corresponde al Astro local, no a la instancia EC2. Antes mostraba “Modo demostración” porque el proceso local no tenía `DATABASE_URL`.

Se añadió:

- `deploy/dev-production.ps1`

El script:

1. Lee la línea `DATABASE_URL` desde EC2 sin mostrarla.
2. Abre túnel SSH local `127.0.0.1:15432` hacia `127.0.0.1:5432` en EC2.
3. Sustituye el puerto en la URL solo en memoria.
4. Arranca Astro en `127.0.0.1:4321`.
5. Cierra el túnel al cerrar Astro en una terminal normal.

Ejecutar desde PowerShell en el workspace:

```powershell
.\deploy\dev-production.ps1
```

La conexión se validó con HTTP 200 y la página dejó de mostrar el aviso de demo. El navegador local fue recargado.

Advertencia: la app local está leyendo producción; cualquier funcionalidad que escriba datos afectará producción. No usar el modo local-production para pruebas destructivas.

## 7. SES y correo

Estado histórico confirmado:

- Direcciones verificadas en SES:
  - `davidt@sempertex.com`
  - `david.theran03@gmail.com`
- Envío de prueba exitoso; MessageId comenzó por `010001a0b0d3d9f1...`.
- Credenciales SMTP generadas para IAM `ses-smtp-marketplace`.
- Archivo de credenciales SMTP en CloudShell: `~/ses_smtp_credentials.txt`.

No incluir credenciales SMTP, contraseñas PostgreSQL, `ADMIN_ACCESS_KEY` ni claves SSH en Git, chat o este documento.

SES continúa en sandbox. Queda pendiente solicitar producción con un caso de uso de correos obtenidos mediante un embudo de ventas, usando inicialmente remitente verificado de `@sempertex.com` para pruebas. La solicitud no quedó enviada en esta sesión.

## 8. Decisiones y pendientes

Decisiones tomadas:

- Usar EC2 + PostgreSQL local en lugar de RDS por ahora.
- Mantener secretos fuera del repositorio.
- Usar Caddy para reverse proxy y HTTPS automático.
- Desplegar exclusivamente desde `main`.
- Usar MCP por SSH/stdio sin puerto público.
- Acceder a producción desde desarrollo mediante túnel SSH, no exponiendo PostgreSQL.
- Dejar `.claude/` local sin versionar porque no forma parte del runtime.

Pendientes prioritarios:

1. Crear el registro DNS `A marketplace -> 54.167.34.107`.
2. Confirmar certificado HTTPS en `https://marketplace.sempertex.com` después de DNS.
3. Decidir y ejecutar backups PostgreSQL; todavía no existen backups programados a S3.
4. Solicitar salida de sandbox de SES con justificación de embudo de ventas.
5. Cerrar SSH público mediante runner privado o SSM cuando el deploy alternativo esté listo.
6. Decidir la limpieza de base de datos. La petición de borrar “toda la información” quedó pausada y **no se ejecutó**.

Para la limpieza hay que elegir explícitamente:

- borrar todos los registros conservando base, tablas y esquema; o
- eliminar la base completa.

No ejecutar ninguna de las dos opciones sin confirmación exacta y, preferiblemente, un backup previo.

## 9. Historial de commits relevantes

```text
bc5a6cb  first commit
36360db  feat: add provider mcp and main deploy
3cb15c0  fix: isolate mcp typecheck from astro build
c3b3f11  fix: read protected runtime env with sudo
54c80ef  feat: polish control panel interface
78488c2  feat: configure remote MCP over SSH
09cb594  feat: connect local app to production database tunnel
```

El siguiente push a `main` vuelve a activar el workflow de despliegue.
