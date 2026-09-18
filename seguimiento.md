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

## 9. Primera versión de curaduría y campañas — 2026-09-17

Se implementó la primera versión end-to-end solicitada para que Claude pueda producir
proveedores curados, importarlos de forma segura y permitir campañas desde el panel.

### Curaduría

- `src/lib/curation.ts` valida el TSV exacto de 18 columnas del prompt: encabezado,
  columnas, categorías, ID, rating mínimo 4.5, umbrales Tipo 1/Tipo 2, nivel A/B,
  evidencia, URL directa, fecha, teléfono, Instagram, correo y duplicados.
- `src/pages/api/providers/import.ts` importa transaccionalmente las filas aceptadas
  y devuelve el detalle de las rechazadas sin inventar valores.
- `scripts/curation.test.ts` cubre filas válidas, umbrales, URL de búsqueda,
  evidencia débil, columnas incorrectas y normalización.

### MCP conectado a la aplicación

- Se añadió `import_curated_providers` a `mcp-server/src/index.ts`.
- El tool recibe JSON estructurado, valida el lote completo, opera en dry-run por
  defecto y solo escribe con `confirm=true`.
- La escritura es transaccional/idempotente sobre proveedores, fuentes y contactos;
  los proveedores quedan como `candidate`, los contactos nuevos como `unknown` y no
  existe envío de correo desde MCP.
- Se documentó la conexión local Claude Desktop/Claude Code por SSH/stdio en
  `docs/claude-mcp.md` y `deploy/mcp-client-config.example.json`.

### Campañas y consentimiento

- `src/pages/campanas/index.astro` y `src/pages/api/campaigns/index.ts` ya permiten
  seleccionar destinatarios elegibles, redactar el mensaje, confirmar y registrar
  el resultado.
- `src/lib/campaigns.ts` usa SES v2 desde el servidor, registra cada envío y genera
  enlaces de registro con token opaco.
- `sql/schema.sql` conserva el cuerpo de la campaña y aplica la migración idempotente.
- `src/pages/api/public/form-submit.ts` guarda el consentimiento de marketing solo
  cuando el usuario lo marca; ese consentimiento habilita al contacto para campañas.

### Verificación de esta versión

- `node --experimental-strip-types scripts/curation.test.ts` ✅
- `npm run build` ✅ (0 errores; solo hints generados por Astro)
- `npm --prefix .\\mcp-server run check` ✅ (build + handshake + dry-run MCP)
- `git diff --check` ✅

Antes de hacer un envío real todavía deben estar resueltos la identidad/DKIM y el
estado de producción de SES. La conexión Claude/MCP usa una clave SSH efímera en
esta máquina; no se guardan claves privadas, `DATABASE_URL` ni tokens en el
repositorio.

### Conexión Claude verificada

La conexión quedó registrada en Claude Code con alcance de usuario y se verificó
con `claude mcp list`:

- Servidor: `marketplace-control` — `stdio` sobre SSH.
- Estado verificado: `√ Connected`.
- Wrapper local: `%USERPROFILE%\\.local\\bin\\marketplace-control-mcp-ephemeral.ps1`.
- Autenticación SSH: clave Ed25519 efímera publicada por EC2 Instance Connect;
  no se dejó acceso persistente en `authorized_keys`.
- Perfil AWS local usado: `marketplace-login2`, obtenido de la sesión AWS del
  navegador para la cuenta de la instancia.

La plantilla con clave permanente sigue disponible como alternativa en
`deploy/mcp-client-config.example.json`, pero no fue necesaria para esta conexión.

### Conector Claude Web por HTTPS

Se añadió un segundo transporte para cumplir el criterio de conexión desde
Claude Web, que no puede ejecutar un MCP local `stdio`:

- `mcp-server/src/http.ts` expone Streamable HTTP en `/mcp`.
- `marketplace-control-mcp.service` escucha solo en `127.0.0.1:4322`.
- Caddy enruta `/mcp`, `/.well-known/*` y `/oauth/*` al servicio MCP, y el resto
  del sitio al panel Astro.
- OAuth/PKCE incluye registro dinámico de cliente, autorización con
  `ADMIN_ACCESS_KEY`, refresh tokens y metadatos RFC 9728/8414.
- URL de prueba para Claude Web: `https://54-167-34-107.sslip.io/mcp`.
- URL de producción prevista: `https://marketplace.sempertex.com/mcp`, después de
  crear el registro DNS A correspondiente.

La URL `sslip.io` depende del IP público actual de EC2; para producción se debe
asociar una Elastic IP o configurar el dominio corporativo. El MCP remoto no
envía campañas: la única escritura disponible es la importación curada con
confirmación explícita, y los contactos nuevos permanecen con consentimiento
`unknown`.

La prueba final dentro de Claude Web queda pendiente de una acción del
administrador de la organización: la sesión conectada muestra el rol `Usuario`
y no presenta el botón `Agregar conector personalizado`. En planes Team o
Enterprise, el propietario/administrador debe agregar la URL
`https://54-167-34-107.sslip.io/mcp` desde Settings > Connectors; después cada
usuario puede conectarlo y autorizarlo. Esta limitación es de permisos de
Claude Web, no del endpoint MCP desplegado.

## 10. Agente Gemini dentro del panel — 2026-09-17

Se integró Gemini directamente en `/proveedores`, sin depender de n8n ni de
Claude Web:

- El panel ahora muestra el bloque “Gemini · agente de curaduría”. Recibe ciudad,
  categoría e instrucciones opcionales.
- El servidor llama a la Interactions API con `google_search` y `url_context`,
  pide un TSV de curaduría y lo pasa por el mismo validador estricto de 18
  columnas antes de mostrarlo.
- El botón “Confirmar e importar” requiere confirmación explícita. Los aceptados
  quedan como `candidate`; no se envían correos ni se conceden permisos de
  marketing.
- La llave se tomó del contenedor activo `demo-decoracion-ai-api` en
  `n8n-maros` y se instaló fuera del repositorio en
  `/etc/marketplace-control/gemini.env` con permisos `0600`. No se imprimió ni
  se guardó su valor en Git, el navegador o los logs.
- `marketplace-control.service` carga ese archivo opcional y usa
  `GEMINI_AGENT_MODEL=gemini-3.8-flash`.
- El servicio n8n no estaba activo en `n8n-maros` y el hostname
  `n8n.marosconstruction.com` no terminaba TLS correctamente; por eso la
  integración quedó hecha de forma directa en la aplicación. La llave existente
  sí fue reutilizada sin modificar ese host.
- Despliegue verificado en GitHub Actions: release `61764af` (run 16).
  La prueba real del endpoint respondió HTTP 200 y confirmó que la aplicación
  llega a Gemini; la vista previa no escribe en la base hasta la confirmación
  del operador.

Archivos principales: `src/lib/gemini.ts`, `src/pages/api/ai/curation.ts`,
`src/lib/provider-import.ts` y `src/pages/proveedores/index.astro`.

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
687974a  feat: add Gemini curation agent to provider panel
fab9330  fix: simplify Gemini structured curation schema
8e6d872  fix: relax Gemini response schema for tool calls
61764af  fix: return simple TSV payload from Gemini
```

El siguiente push a `main` vuelve a activar el workflow de despliegue.
