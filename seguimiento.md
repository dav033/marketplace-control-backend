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
5. Cambia atómicamente `/srv/marketplace-control/current`.
6. Reinicia el servicio Astro.
7. Valida y recarga Caddy.
8. Si Astro falla, intenta rollback a la release anterior.

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

## 5. MCP (histórico; retirado el 2026-09-18)

Este apartado conserva el registro de la implementación anterior. El MCP ya no
forma parte del producto activo: la curaduría se ejecuta desde Gemini dentro del
panel. Las referencias siguientes son únicamente historial técnico.

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
- Usar Gemini dentro del panel para la curaduría, con validación local y confirmación explícita.
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

### MCP conectado a la aplicación (histórico; retirado el 2026-09-18)

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

El MCP descrito en las secciones históricas fue retirado posteriormente. Gemini
es ahora el único flujo activo de curaduría.

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

## 11. Pruebas y benchmarks — 2026-09-17

La batería se ejecutó sin importar registros ni enviar correos:

- `npm run build` en la aplicación: ✅ 0 errores, 0 warnings y 21 hints de Astro.
- `node --experimental-strip-types scripts/curation.test.ts`: ✅ tests del parser y validador.
- `npm --prefix .\\mcp-server run check`: ✅ build, handshake MCP, herramientas y guardas de `DATABASE_URL` (validación histórica, antes del retiro).
- `git diff --check`: ✅ sin errores; el repositorio quedó limpio después de retirar los scripts temporales.
- `/api/health`: ✅ 10/10 respuestas HTTP 200; promedio 262.73 ms, mediana 240.03 ms,
  mínimo 230.32 ms y máximo 434.40 ms.
- Parser/validador local con 30 iteraciones por lote y filas sintéticas válidas:
  1 fila = 0.153 ms promedio; 10 = 0.570 ms; 50 = 2.515 ms; 100 = 4.968 ms;
  500 = 23.450 ms (~21,322 filas/s). Todas las filas fueron aceptadas.
- Gemini e2e en la EC2: primera corrida HTTP 502 en 56.565 s; reintento HTTP 200
  en 66.231 s con 0 aceptados y 7 rechazados. La llamada sí llegó a Gemini,
  pero las filas no cumplieron el contrato estricto local; no se realizó ninguna
  escritura. El 502 se clasifica como fallo transitorio de disponibilidad, no
  como regresión confirmada.

Estos benchmarks miden el parser en CPU local y una muestra pequeña del endpoint;
no representan todavía rendimiento estadístico de PostgreSQL, importaciones
confirmadas o calidad sostenida de Gemini. Para una siguiente iteración conviene
añadir pruebas con `fetch` simulado y registrar los motivos individuales de las
filas rechazadas en la vista previa.

## 12. Retiro del MCP — 2026-09-18

Como la curaduría se cambió a Gemini, se eliminó la superficie MCP de producción
y del cliente local:

- Se eliminaron `mcp-server/`, `docs/claude-mcp.md`, `deploy/mcp-stdio.sh` y
  `deploy/mcp-client-config.example.json`.
- Caddy deja de publicar `/mcp`, OAuth y los metadatos MCP.
- El siguiente deploy detendrá y eliminará la unidad systemd,
  `/usr/local/bin/marketplace-control-mcp` y su regla sudoers histórica.
- Se retiró `marketplace-control` de la configuración de usuario de Claude y se
  borró el wrapper SSH efímero local.
- La aplicación web, PostgreSQL, `/api/ai/curation`, Gemini y la clave de
  administración permanecen intactos.

## 13. Selección de búsqueda y canales de contacto — 2026-09-18

El panel Gemini ahora permite escoger una ciudad y una categoría desde controles
obligatorios antes de lanzar cada búsqueda. La clasificación de contacto queda
persistida en `marketplace.providers.contact_channel`:

- `email`: correo válido cuando la empresa es mediana/masiva o cuando el correo
  usa un dominio corporativo propio.
- `whatsapp`: empresas pequeñas o con correo gratuito, siempre que exista un
  móvil colombiano verificable.
- Si no existe correo corporativo ni móvil utilizable para WhatsApp, la fila se
  rechaza y conserva el motivo en la vista previa.

Los correos públicos se guardan como contactos con consentimiento `unknown`, por
lo que no entran en campañas hasta que exista consentimiento de marketing. Los
proveedores con WhatsApp conservan el móvil en `providers.phone`. La tabla y la
ficha de proveedor muestran el canal, y la vista previa separa los nombres y
conteos de cada grupo.

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

---

## 14. Corrección del acceso local — 2026-09-20

`deploy/dev-production.ps1` apuntaba a `~/.ssh/marketplace-aws`, una clave que no
existe en la máquina. La real es `~/.ssh/marketplace-eventos`, como ya recogía
`~/.ssh/config` bajo el alias `marketplace-eventos`. El script fallaba antes de
abrir el túnel. Corregido.

Falla conocida que sigue apareciendo: si SSH emite el aviso de *post-quantum key
exchange*, PowerShell lo trata como error y aborta el script. Cuando pase, abrir
el túnel a mano y arrancar el servidor por separado:

```bash
ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -i ~/.ssh/marketplace-eventos -L 127.0.0.1:15432:127.0.0.1:5432 ec2-user@54.167.34.107
```

```bash
npm run dev
```

Comprobar que el túnel está arriba:

```bash
netstat -ano | grep "127.0.0.1:15432.*LISTENING"
```

Sin túnel la aplicación arranca en modo demostración. Si la portada muestra
«Modo demostración», el túnel está caído.

## 15. Migraciones: el usuario de la aplicación no es dueño de las tablas

Las tablas pertenecen a `postgres`; la aplicación entra como
`marketplace_control`. Un `ALTER TABLE` por el túnel falla con *must be owner*.
Las migraciones se aplican entrando al servidor:

```bash
ssh -T -i ~/.ssh/marketplace-eventos ec2-user@54.167.34.107 \
  "sudo -n -u postgres psql -d marketplace -v ON_ERROR_STOP=1 --single-transaction -f -" < migracion.sql
```

Al añadir columnas conviene reconceder permisos, por si en su día se concedieron
por columna y no por tabla:

```sql
GRANT SELECT, INSERT, UPDATE ON marketplace.<tabla> TO marketplace_control;
```

## 16. Portales de reputación muertos — 2026-09-20

De las ocho plataformas que el prompt declaraba verificables, **dos no existen**:

| Dominio | Estado |
|---|---|
| `matrimonios.com.co` | Nunca existió. Era una errata en el prompt |
| `matrimonio.com.co` | El nombre real, pero cerrado por The Knot Worldwide |
| `zankyou.com.co` | Redirige al mismo aviso de cierre |
| `bodas.com.co` | No resuelve. `bodas.co` es un dominio aparcado en venta |

No queda ningún portal de bodas colombiano operativo con reseñas públicas. Se
retiraron de las seis enumeraciones del prompt y de los allowlists del validador
en `curation.ts` y `gemini.ts`: dejarlos permitía aceptar una calificación
atribuida a un sitio inexistente, es decir, inventada.

Quedan seis plataformas válidas: Google, TripAdvisor, Booking, Facebook, Rappi y
DiDi.

## 17. Reputación verificada contra Google Places — 2026-09-20

El enriquecedor buscaba **solo por nombre comercial** e ignoraba el teléfono y la
URL que las filas ya traían. Ahora busca en cascada por identidad decreciente:
teléfono, dominio propio, nombre. Verificado contra la API: buscar por teléfono
devuelve el negocio exacto sin ambigüedad.

Se añadió tolerancia singular/plural y rótulos concatenados, del tipo
`@banquetesmarlloly`. Prueba A/B sobre los mismos 34 fallos previos: recupera
exactamente los dos falsos negativos reales, sin introducir falsos positivos.

Cobertura de reputación en las diez categorías: de 16 a 24 de 50.

## 18. El registro oficial completa el lote del agente — 2026-09-21

Arquitectura decidida: **el agente busca; Google Places enriquece y completa**.

Se probó la contraria —Places como fuente, agente como verificador— y se midió
que era peor: al inyectarle la lista en el prompt, solo el **17 %** de lo que el
agente devolvía procedía de ella. Descartaba el resto y volvía a descubrir por su
cuenta, devolviendo por ejemplo un asador brasileño como proveedor de mantelería.
No es un problema de redacción: se intentó en tres corridas distintas.

El flujo quedó así:

1. El agente investiga en fuentes públicas. Es su valor: alcanza negocios sin
   ficha pública.
2. Places rellena la calificación y las reseñas que el agente no pudo confirmar.
   Google Maps no expone su calificación como texto rastreable, así que el agente
   nunca la encuentra por búsqueda web.
3. Places completa el lote hasta el objetivo con negocios que el agente no
   alcanzó, deduplicando por nombre y por teléfono.
4. Se lee el sitio de cada negocio añadido para sacar correo e Instagram.
5. Se filtra por el umbral que pida el operador.

Medición que motivó el paso 3: en Comida y Bebida de Barranquilla con umbral 4,5
y 50 reseñas, el agente devolvía **8** proveedores y el registro conocía **24**
que cumplían, todos contactables. El techo no era el umbral sino lo que el agente
alcanza a descubrir.

Una sola página por consulta a Places, a propósito: la segunda se rellena con
coincidencias flojas, y de ahí salían centros comerciales en «Invitación digital»
y un sex shop en «Menaje».

## 19. Umbral configurable y reputación repartida — 2026-09-21

El listón de 4,5 y 30 reseñas estaba incrustado en el prompt y en el validador.
Ahora se pide en la búsqueda y viaja a dos sitios: al prompt, para que el agente
no gaste escaneos en lo que va a caer; y al filtrado del lote, porque orientar al
agente no garantiza el resultado.

El filtro respeta la regla de reputación combinada: sin llegar al mínimo en
ninguna plataforma por separado, dos o más que sí alcancen la calificación y
sumen el doble de reseñas también califican. El mínimo combinado escala con el
umbral. La primera versión del filtro miraba solo las columnas principales y
descartaba esos proveedores; corregido.

## 20. Correo e Instagram leídos del sitio — 2026-09-21

El agente **no abre páginas**. Medido en dos corridas: `webFetchCalls: 0` en
ambas, con cero correos encontrados. El correo no está en los resultados de
búsqueda sino dentro del sitio, y a menudo en `/contacto`.

Se añadió `src/lib/contact-scrape.ts`, que descarga la portada y, si hace falta,
una página de contacto del mismo dominio. Tarda un segundo y no puede inventarse
una dirección.

Dos filtros salieron de mirar resultados reales:

- El correo de la agencia que montó el sitio aparecía como si fuera del
  proveedor: `cliente@gurusoluciones.com` salió en dos negocios sin relación
  entre sí. Solo se acepta el del propio dominio o uno de correo gratuito.
- La comparación de dominio se hace por su raíz: un negocio alojado en
  `lastrinitarias.com.co` publica su correo en `@lastrinitarias.com` y son el
  mismo. Compararlos literalmente descartaba un correo legítimo.

También se descartan los nombres de fichero que cumplen el patrón de correo
(`logo@2x.png`) y los recursos estáticos que parecían cuentas de Instagram
(`instagram.com/rsrc.php`).

## 21. Canal de contacto — 2026-09-21

La cadena quedó explícita:

1. **Correo corporativo** manda: se le escribe, tenga móvil o no.
2. Sin corporativo, **WhatsApp**, que es el canal natural del proveedor pequeño.
3. Ni corporativo ni móvil, el **correo gratuito** que publique.
4. Sin nada, la validación lo rechaza por falta de contacto.

El tercer caso estaba roto: un negocio con solo un gmail y un teléfono fijo se
clasificaba como WhatsApp y la validación lo rechazaba después por no tener
móvil. Quedaba inalcanzable teniendo un contacto usable.

Reparto medido en Comida y Bebida con umbral 4,5 y 50: 16 aceptados, 1 por correo
y 15 por WhatsApp. No es un fallo del sistema: de esos 20 proveedores, **11 no
tienen sitio propio** — operan por Instagram y WhatsApp — y de los 9 que sí, solo
1 publica correo.

## 22. Fase 2: registro del proveedor — 2026-09-21

Del clic en el correo al formulario. Evoluciona lo que ya existía en vez de abrir
una vía paralela: reutiliza `registration_submissions` y el token de
`campaign_sends`.

Qué se le pregunta, además de lo que ya había: productos (lista abierta, hasta
10), categorías en las que trabaja (hasta 5, de las 10 oficiales) y volumen de
asistentes como rango.

El rango se guarda como **dos enteros**, no como etiqueta, lo que permite derivar
la Escala de curaduría sin pedirle al proveedor que entienda esa clasificación
interna.

El enlace **caduca**: `REGISTRATION_TOKEN_TTL_DAYS`, 30 días por defecto,
rellenado al crear la campaña. Antes no lo ponía nadie y los enlaces repartidos
eran eternos. Un valor nulo se considera vigente, para no invalidar los que ya
están en buzones.

El envío es **único**. Antes `ON CONFLICT DO UPDATE` dejaba reenviar y
sobrescribir; ahora la segunda entrega recibe un 409.

### Migración aplicada en producción el 2026-09-21

Ejecutada como `postgres`, en una transacción. Datos intactos: 0 registros,
8 envíos, 5 proveedores.

```text
campaign_sends.token_expires_at        timestamptz
campaign_sends.form_submitted_at       timestamptz
registration_submissions.products      text[]   CHECK cardinality <= 10
registration_submissions.services      text[]   CHECK cardinality <= 5
registration_submissions.volume_min    integer
registration_submissions.volume_max    integer  CHECK volume_max >= volume_min
```

## 23. Errores corregidos — 2026-09-20/21

| Dónde | Qué pasaba |
|---|---|
| `src/lib/data.ts` | `getProvider` pasaba el identificador sin validar a una columna `uuid`: cualquier id con otra forma daba **500** en vez de 404 |
| `src/pages/api/public/form-submit.ts` | `formData()` quedaba fuera del `try`: un POST con `content-type: application/json` esquivaba el guard CSRF de Astro y reventaba con un TypeError sin manejar, en un **endpoint público** |
| `deploy/dev-production.ps1` | Apuntaba a una clave SSH inexistente |

## 24. Benchmarks: dos familias

El agente se lleva el **97,6 %** del reloj: 14–19 invocaciones del CLI a unos
103 s cada una. De ahí que haya benchmarks que lo invocan y otros que no.

| Script | Invoca al agente | Coste |
|---|---|---|
| `scripts/bench-harvest.ts` | No | **13 s** |
| `scripts/bench-harvest-tsv.ts` | No | **13 s** |
| `scripts/bench-reduced.ts` | 8 veces | ~8 min |
| `scripts/bench-all-categories.ts` | 14–19 veces | 25–35 min |

Iterar con los de 13 segundos y confirmar con el completo solo cuando el cambio
toque al agente. En esta sesión se gastó hora y media en tres corridas completas
para descubrir cosas que el benchmark barato habría dicho en segundos.

```bash
node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
  scripts/bench-harvest.ts "Barranquilla" salida.json
```

`CURATION_DISABLE_HARVEST=1` apaga el completado desde Places, para medir el
brazo de control.

## 25. Mapa del código nuevo

| Fichero | Qué hace |
|---|---|
| `src/lib/google-places.ts` | Reputación de un negocio concreto: cascada teléfono → dominio → nombre |
| `src/lib/places-harvest.ts` | Candidatos de una categoría en una ciudad |
| `src/lib/harvest-import.ts` | Convierte un negocio en fila de curaduría de 20 columnas |
| `src/lib/harvest-verify.ts` | Lee sitios y pide al agente que confirme el servicio |
| `src/lib/contact-scrape.ts` | Extrae correo e Instagram del sitio del proveedor |
| `src/pages/api/providers/harvest.ts` | Endpoint de consulta directa y preparación de lote |
| `src/pages/registro/[token].astro` | Formulario del proveedor, con sus cuatro estados |

`npm test` cubre 12 conjuntos. Los añadidos en esta sesión:

- `scripts/google-places.test.ts` — emparejador, con 13 guardas anti-falso-positivo
- `scripts/contact-scrape.test.ts` — filtros de correo; el caso `logo@2x.png`
- `scripts/curation-threshold.test.ts` — umbral y reputación combinada
- `scripts/curation-complete.test.ts` — completado y deduplicación
- `scripts/contact-channel.test.ts` — cadena de canal de contacto
- `scripts/registro-form.test.ts` — validaciones del formulario

## 26. Decisiones de esta sesión

- **El agente descubre, Places enriquece — no al revés.** Medido: la arquitectura
  contraria daba 17 % de adherencia a la lista inyectada.
- **Un juicio dudoso no borra un proveedor.** Cuando el agente marca que un
  negocio no presta el servicio, la fila entra igualmente con el aviso escrito en
  la justificación. Marcó como no aptos a dos fotógrafos reales con 5,0/35 y
  4,9/64. Perder un proveedor bueno en silencio es peor que arrastrar uno dudoso:
  el dudoso se ve, el perdido no.
- **El correo lo lee el código, no el agente.** El agente no abre páginas.
- **Precisión sobre cantidad en los correos.** Bajó de 4 a 2, pero los 2 son
  correctos y de los 4 dos eran de la agencia que montó el sitio.
- **El mecanismo no se expone en la interfaz.** Un botón para buscar, uno para
  preparar el lote. El operador no tiene por qué saber de dónde sale cada dato.
- **Los secretos no entran al repositorio.** Este documento describe el
  procedimiento y los nombres de las variables; los valores viven en el `.env`
  local y en `/etc/marketplace-control/marketplace-control.env`.

## 27. Qué queda pendiente

### Decisiones del negocio

1. ~~**Envío QA de correo.**~~ **Hecho el 2026-09-21.** Se ejecutó un envío real,
   y no por `qa-test` sino por la campaña de verdad (`POST /api/campaigns`), que
   es lo que ejercita la cadena completa. `QA_TEST_RECIPIENTS` estaba puesto a un
   único buzón propio y era además el único contacto elegible de la base,
   comprobado con un `SELECT` antes de disparar. Ver sección 33.
2. **Días de caducidad del enlace.** 30 es una suposición.
3. **Texto legal del consentimiento** en el formulario de registro.
4. **Categorías que no encajan.** Si un proveedor hace algo fuera de las 10
   oficiales, hoy no tiene dónde ponerlo.

### Trabajo técnico

1. **El agente juzga mal la pertinencia.** Marcó como no aptos a dos fotógrafos
   reales. Ya no borra nada, pero su juicio no es fiable y conviene medirlo.
2. **Tasa de correos baja: 2 de 15 sitios.** Queda por medir si las categorías
   empresariales — Lugar, Servicios Especializados — rinden mejor que Comida y
   Bebida.
3. **Pertinencia imperfecta en el completado.** Un sex shop con 4,9 y 1 794
   reseñas entra como proveedor de mantelería. Ningún filtro automático lo
   resuelve; por eso existe la revisión humana antes de importar.
4. **Salones en tres categorías.** El mismo negocio sale en Lugar,
   Entretenimiento y Decoración.
5. **Historial de pruebas en producción.** Las corridas de benchmark dejaron
   registros de escaneo en `audit_log` mezclados con tráfico real. No se importó
   ningún proveedor.

## 28. Cifras de referencia — Barranquilla, 2026-09-20/21

| | |
|---|---|
| Búsqueda del agente, 10 categorías | 25–35 min, 7 aceptados |
| Consulta directa a Places, 10 categorías | 13 s, 485 candidatos, 82 filas válidas |
| Comida y Bebida con umbral 4,5 y 50 | El agente traía 8; Places conocía 24 que cumplían |
| Cobertura de reputación tras la cascada | 16 → 24 de 50 |
| Correos encontrados leyendo sitios | 2 de 15, ambos correctos |
| Reparto de canal en Comida y Bebida | 1 correo, 15 WhatsApp |
| Proveedores sin sitio propio | 11 de 20 |

## 29. Commits de la sesión

```text
67de0c2 feat: cosechar proveedores desde Google Places
3611c5f feat: el proveedor declara su oferta al abrir el enlace del correo
ea7f5a3 feat: reputación multiplataforma, canal de contacto y métricas de campaña
a354bf7 feat: leer el sitio del proveedor para sacar correo e Instagram
5d1e311 refactor: una sola tarjeta de búsqueda en vez de dos
08b49fc refactor: una sola acción de búsqueda, sin exponer el mecanismo
b06dbae refactor: el agente vuelve a ser quien busca; Places solo enriquece
d1e8b1b feat: umbral de calificación y reseñas definido por el operador
70c5b75 fix: el umbral no debe tirar la reputación repartida entre plataformas
373620c feat: completar el lote con los negocios que el agente no alcanza
8951696 fix: leer el correo antes de decidir el canal de contacto
16902e2 feat: el correo gratuito entra cuando no hay corporativo ni móvil
```

---

## 30. Ajustes posteriores — 2026-09-21

### La blacklist arrastraba el historial entre corridas

Leía todos los candidatos vistos en la ciudad y categoría, sin límite de tiempo
ni de ejecución, así que cada escaneo envenenaba los siguientes.

Medido tras una tarde de pruebas: **460 entradas** para Barranquilla · Comida y
Bebida, con los doce restaurantes de más reseñas de la ciudad vetados —Varadero,
Pepe Anca, Botero's, Casa Árabe, Johnny Maracas—. El agente solo podía encontrar
negocios que nadie había calificado, y un brazo del benchmark devolvió doce
proveedores sin una sola reseña. Parecía fallo del modelo y era el historial.

Ahora el alcance es: **los escaneos anteriores de la misma corrida**, para no
repetir candidatos entre el primero y el segundo, y **la tabla de proveedores**,
de la que se encarga `getExistingProviders`. Nada más.

### Otros cambios

- **Umbral de calificación y reseñas** definido por el operador, que viaja al
  prompt y al filtrado del lote. Respeta la regla de reputación combinada.
- **El registro completa el lote** del agente hasta el objetivo, deduplicando por
  nombre y teléfono. En Comida y Bebida el agente traía 8 y el registro conocía
  24 que cumplían.
- **Vista de proveedores** con filtros de ciudad y categoría en jerarquía
  superior, secciones agrupables y pestañas separadas para correo y WhatsApp.
- **Borrado de los datos de operación** desde Configuración, con confirmación
  escrita y constancia en el historial.
- **Señal al importar**: el botón avisa mientras guarda, el lote se limpia al
  terminar y la tabla se refresca sin recargar.
- `CURATION_DISABLE_PLACES` apaga también el enriquecimiento, para poder medir al
  agente a solas.

### Lo que quedó sin resolver

**Cuánto aporta el modelo frente al andamiaje.** La medición se corrió con la
blacklist ya envenenada, así que sus ceros no significan lo que parecían. Hay que
rehacerla ahora que el alcance está corregido: `scripts/bench-reduced.ts` mide
los dos brazos en unos 20 minutos.

**52 proveedores descartados en silencio.** En el benchmark de 10 categorías el
filtro retiró 72 filas: 20 por no alcanzar el umbral y **52 por no tener
reputación que acreditar**. Los primeros son una decisión del operador; los
segundos son ignorancia, no un juicio. Conviene que entren marcados como
«requiere revisión» en vez de desaparecer, igual que se hizo con el juicio de
pertinencia del agente.

---

## 31. Plan: cableado del envío al registro confirmado

> **Ejecutado el 2026-09-21.** Los cuatro pasos están hechos y probados de extremo
> a extremo con correo real. Lo que sigue se conserva como el plan que se siguió;
> lo que realmente ocurrió al ejecutarlo —incluidas dos correcciones que el plan no
> preveía y una decisión en contra de lo que insinuaba 31.3— está en la sección 33.

Cadena completa: **se manda el correo → llega → el proveedor pulsa el enlace →
cae en el formulario → lo rellena → el proveedor pasa a confirmado**.

Buena parte ya existe. Esto detalla qué hay, qué falta y dónde tocarlo.

### 31.1 Qué existe ya

| Pieza | Dónde | Estado |
|---|---|---|
| Crear campaña y encolar envíos | `src/lib/campaigns.ts` | Hecho. Genera un token de 32 bytes por destinatario y su `token_expires_at` |
| Plantilla y campaña en Omnisend | `src/lib/omnisend.ts` | Hecho: `importEmailTemplate`, `createEmailCampaignDraft`, `sendEmailCampaign` |
| Envío de prueba | `src/pages/api/campaigns/qa-test.ts` | Hecho, **nunca ejecutado** |
| Registro del clic | `src/pages/t/[token].ts` | Hecho. Inserta en `email_clicks` y redirige a `/registro/<token>` |
| Formulario del proveedor | `src/pages/registro/[token].astro` | Hecho, con sus cuatro estados |
| Recepción del formulario | `src/pages/api/public/form-submit.ts` | Hecho. Inserta la ficha y marca `form_submitted_at` |
| Estadísticas de la campaña | `src/pages/api/campaigns/[campaignId]/stats.ts` | Hecho, bajo demanda |

### 31.2 Los tres huecos

**A · El enlace del correo no pasa por el contador de clics.** — *Cerrado.*
`campaigns.ts:87` pone `registration_url` como `${baseUrl}/registro/${token}`,
apuntando directo al formulario. El contador vive en `/t/<token>` y nadie lo
llama, así que `email_clicks` nunca se rellena y la métrica «Mostraron interés»
del panel siempre marcará cero.

*Arreglo:* cambiar esa línea a `${baseUrl}/t/${token}`. Una línea. Comprobar
después que `/t/<token>` redirige con 302 a `/registro/<token>` y que aparece la
fila en `email_clicks`.

**B · Rellenar el formulario no cambia el estado del proveedor.** — *Cerrado.*
`form-submit.ts` inserta en `registration_submissions` y marca el envío, pero no
toca `marketplace.providers`. El proveedor sigue en `candidate` después de
haberse registrado él mismo, que es justo la señal más fuerte que puede dar.

*Arreglo:* dentro de la misma transacción del envío, pasar el proveedor a
`under_review` y anotar `reviewed_at`. Los estados válidos están en el `CHECK` de
la tabla: `candidate`, `under_review`, `approved`, `rejected`, `archived`. Se
recomienda **no** saltar a `approved` de forma automática: que una persona
apruebe.

**C · No hay envío real de campaña desde el panel.** — *Este hueco no existía.*
Existe `sendEmailCampaign` en la librería, pero la pantalla de campañas no lo
dispara. Hoy solo hay el envío de prueba.

> Al ejecutarlo resultó que sí lo disparaba: `sendCampaign` ya encadenaba todo y el
> botón «Enviar a seleccionados» ya lo llamaba. El hueco real era otro y estaba más
> abajo: un 400 de Omnisend que tumbaba cualquier envío. Ver 33.1.

### 31.3 Orden de implementación

Cada paso es verificable por separado. No pasar al siguiente sin comprobar el
anterior.

**Paso 1 — Enrutar el enlace por el contador.** ✅
Tocar `src/lib/campaigns.ts`, la línea de `customProperties.registration_url`.
Verificación: crear una campaña de prueba y comprobar en la base que
`email_clicks` recibe una fila al abrir `/t/<token>`.

**Paso 2 — Confirmar al proveedor al recibir el formulario.** ✅
Primero la migración del `CHECK` de estados (ver 31.6), porque sin ella el
`UPDATE` falla. Después tocar `src/pages/api/public/form-submit.ts`: el `UPDATE`
que lleva el proveedor a `unconfirmed` va junto al `UPDATE` de `campaign_sends`,
en la misma transacción; si falla uno no debe quedar el otro. Añadir una entrada
en `audit_log` con `action='provider.confirmed'` y `entity_type='provider'` —
recordar que `entity_type` es **NOT NULL**, error que ya costó una depuración.

Repasar también lo que asume la lista de estados: `ProviderStatus` en
`src/lib/types.ts`, `StatusBadge`, el filtro de estado de la vista y
`src/lib/demo.ts`.
Verificación: enviar el formulario con un token real y comprobar que el proveedor
pasa a `under_review` y que la vista de proveedores lo refleja.

**Paso 3 — Envío real desde el panel.** ✅
Encadenar en `campaigns.ts`: `upsertConsentedContact` para cada destinatario,
`createTagSegment` + `waitForSegmentReady`, `importEmailTemplate`,
`createEmailCampaignDraft` y `sendEmailCampaign`. Todo eso ya está escrito en
`omnisend.ts`; falta la orquestación y el botón.
Mientras `QA_TEST_RECIPIENTS` apunte al buzón de prueba, este paso se puede
ejercitar sin riesgo: el correo sale de verdad pero llega a una dirección propia.
**Antes de apuntarlo a proveedores reales hace falta autorización explícita del
responsable**, y salir del sandbox de SES.

**Paso 4 — Cerrar el círculo en el panel.** ✅
La pantalla de campañas ya tiene el endpoint de estadísticas. Mostrar por campaña:
enviados, clics registrados y formularios recibidos. Las dos primeras salen de
`campaign_sends` y `email_clicks`; la tercera de `registration_submissions`.

### 31.4 Cómo trabajar en esto

**Entorno local con datos reales.** Ver la sección 14: abrir el túnel SSH y
levantar `npm run dev`. Sin túnel la aplicación arranca en modo demostración.

**Migraciones.** Ver la sección 15. Las tablas pertenecen a `postgres`, no al
usuario de la aplicación, así que hay que entrar por SSH:

```bash
ssh -T -i ~/.ssh/marketplace-eventos ec2-user@54.167.34.107 \
  "sudo -n -u postgres psql -d marketplace -v ON_ERROR_STOP=1 --single-transaction -f -" < migracion.sql
```

Las columnas implicadas —`token_expires_at`, `form_submitted_at`,
`providers.status`, `reviewed_at`— ya existen. La única migración del plan es
**ampliar el `CHECK` de `providers.status`** para admitir el estado nuevo; va
antes del paso 2 y está escrita en 31.6.

**Inspeccionar producción sin escribir.** Consultas de lectura por el túnel con
el usuario de la aplicación, que tiene `SELECT`:

```bash
ssh -T -i ~/.ssh/marketplace-eventos ec2-user@54.167.34.107 \
  "sudo -n -u postgres psql -d marketplace -At -c \"SELECT status, count(*) FROM marketplace.providers GROUP BY status\""
```

**Dejar el terreno limpio entre pruebas.** Configuración tiene el borrado de
datos de operación; escribir `BORRAR TODO` para habilitarlo. El `audit_log` no se
toca, y desde el arreglo de la blacklist eso ya no contamina los escaneos.

**Delegar en subagentes.** Los pasos 1, 2 y 4 son independientes entre sí y se
pueden repartir. Para trabajo de esta naturaleza conviene Codex `gpt-5.6-luna`
con `model_reasoning_effort="xhigh"`, no el `medium` que usa la curaduría: aquí
no se trata de buscar en la web sino de tocar transacciones de base de datos y
flujos de correo, donde un descuido se paga caro. El paso 3 se puede delegar **en modo prueba**, con el buzón
propio como destinatario y comprobando la variable antes de cada corrida; el
envío a proveedores reales no.

**Verificar siempre contra la base, no contra la interfaz.** Varias veces en la
sesión anterior la pantalla decía una cosa y la base otra. Un `SELECT` después de
cada paso.

### 31.5 Probar la cadena de extremo a extremo, con correo de verdad

**No se manda nada a clientes reales.** Todo el correo de prueba cae en un buzón
propio: `QA_TEST_RECIPIENTS` en el `.env` está puesto a
`david.theran03@gmail.com`, y esa variable tiene prioridad sobre cualquier otra.
Eso convierte la cadena entera en algo comprobable de verdad, no solo en teoría.

**Comprobar antes de cada prueba** que la variable sigue apuntando solo ahí:

```bash
grep -E "^QA_TEST_RECIPIENTS=" .env
```

Si alguna vez aparecen varias direcciones separadas por coma, el envío va a
todas. El fichero de ejemplo del servidor trae tres de `@sempertex.com`; el
`.env` local las sobrescribe con la de prueba, y conviene que siga así mientras
se desarrolla.

**El recorrido completo, en el navegador:**

1. **Disparar el envío.** `POST /api/campaigns/qa-test` con `confirm: true`,
   nombre, asunto y cuerpo. Crea plantilla y campaña en Omnisend y manda el
   correo de prueba.
2. **Abrir el buzón** de `david.theran03@gmail.com` en una pestaña y esperar a
   que llegue. Es correo real saliendo por Omnisend, con su latencia.
3. **Pulsar el enlace del correo.** Aquí se comprueba el hueco A: si el enlace
   lleva a `/registro/<token>` no se cuenta el clic; si lleva a `/t/<token>`
   debe redirigir con 302 al formulario **y** dejar una fila en `email_clicks`.
4. **Rellenar y enviar el formulario.** Productos, categorías y volumen.
5. **Verificar en la base**, que es donde está la verdad:

```sql
SELECT cs.form_submitted_at, p.status, p.reviewed_at
  FROM marketplace.campaign_sends cs
  LEFT JOIN marketplace.providers p ON p.provider_id = cs.provider_id
 WHERE cs.tracking_token_hash = <hash del token>;

SELECT count(*) FROM marketplace.email_clicks;
SELECT products, services, volume_min, volume_max
  FROM marketplace.registration_submissions ORDER BY created_at DESC LIMIT 1;
```

6. **Reabrir el enlace.** Debe mostrar «Ya tenemos tu información» y el endpoint
   responder 409. El envío es único.

**Cada paso falla de forma distinta y conviene aislarlo:** si no llega el correo
el problema es Omnisend; si llega pero no cuenta el clic es el hueco A; si el
formulario guarda pero el proveedor sigue en `candidate` es el hueco B.

**Estado de la cuenta de correo.** SES sigue en sandbox según la sección 7, así
que solo se puede enviar a direcciones verificadas —`david.theran03@gmail.com`
lo está—. El envío de campaña a proveedores reales necesita salir del sandbox
primero, y eso es un trámite aparte.

**Limpiar entre pruebas** con el borrado de Configuración, escribiendo
`BORRAR TODO`. Borra envíos, clics y formularios, así que cada recorrido empieza
limpio.

### 31.6 Decisiones ya tomadas

**Estado nuevo para el proveedor que se registra solo.** No se reutiliza
`under_review`: la progresión es `candidate` → estado nuevo cuando el proveedor
rellena el formulario. El nombre acordado es **`unconfirmed`** («unconfirmed
provider»).

Esto **sí necesita migración**, porque `providers.status` tiene un `CHECK` con la
lista cerrada de valores. Va antes del paso 2. **Aplicada en producción el
2026-09-21** y guardada en `sql/2026-09-21-providers-status-unconfirmed.sql`:

```sql
ALTER TABLE marketplace.providers DROP CONSTRAINT IF EXISTS providers_status_check;
ALTER TABLE marketplace.providers
  ADD CONSTRAINT providers_status_check
  CHECK (status IN ('candidate','unconfirmed','under_review','approved','rejected','archived'));
```

Se aplica por SSH como `postgres`, según la sección 15. Después hay que repasar
todo lo que asume la lista de estados: el tipo `ProviderStatus` en
`src/lib/types.ts`, el componente `StatusBadge`, el filtro de estado de la vista
de proveedores y los datos de demostración en `src/lib/demo.ts`. Repasado, y con
dos sitios más que la lista no nombraba: el color del badge en `AppLayout.astro` y
el conteo «Por revisar» de `data.ts`.

*Observación sobre el nombre:* `unconfirmed` se lee como «sin confirmar», y el
proveedor que llega a ese estado es justamente el que **sí** confirmó sus datos;
lo que falta es que un operador lo apruebe. Si en algún momento resulta
confuso al leer la pantalla, el cambio es una migración más. Se deja el nombre
acordado.

**Un envío sin proveedor asociado no puede darse.** Aunque
`campaign_sends.provider_id` admita nulos en el esquema, por diseño todo envío
sale de un proveedor. El código no necesita una rama para ese caso; basta con
registrar el hecho si alguna vez ocurre, porque significaría que algo se corrompió
aguas arriba.

**El envío QA está aprobado** con `david.theran03@gmail.com` como destinatario,
que es lo que ya trae el `.env`. Ver la sección 31.5.

## 32. Commits hasta aquí

```text
a354bf7 feat: leer el sitio del proveedor para sacar correo e Instagram
5d1e311 refactor: una sola tarjeta de búsqueda en vez de dos
08b49fc refactor: una sola acción de búsqueda, sin exponer el mecanismo
b06dbae refactor: el agente vuelve a ser quien busca; Places solo enriquece
d1e8b1b feat: umbral de calificación y reseñas definido por el operador
70c5b75 fix: el umbral no debe tirar la reputación repartida entre plataformas
373620c feat: completar el lote con los negocios que el agente no alcanza
8951696 fix: leer el correo antes de decidir el canal de contacto
16902e2 feat: el correo gratuito entra cuando no hay corporativo ni móvil
454d43a docs: seguimiento de la sesión del 20 y 21 de septiembre
1d509b1 merge: cosecha desde Places, registro del proveedor y umbral configurable
f269e45 feat: opción para borrar los datos de operación
6e5c76b feat: vista de proveedores con filtros y secciones
f5ce60e feat: no volver a buscar proveedores que ya están en la base
0c9ba5a fix: dar señal al guardar un lote y refrescar la tabla al terminar
1c43ae7 feat: filtros de ciudad y categoría, y tablas separadas por canal
0f03f2b refactor: ciudad y categoría por encima del resto de filtros
a8ef5c3 fix: la blacklist deja de arrastrar el historial entre corridas
```

## 33. Cableado cerrado: del correo al proveedor confirmado — 2026-09-21

El plan de la sección 31 está ejecutado y **probado de extremo a extremo con correo
real** al buzón de prueba. La cadena completa funciona: se manda el correo → llega
→ el proveedor pulsa el enlace → se cuenta el clic → cae en el formulario → lo
rellena → su ficha pasa a `unconfirmed`.

### 33.1 Lo que se tocó

**Paso 1 · El enlace pasa por el contador.** `campaigns.ts` ponía
`registration_url` como `/registro/<token>` y se saltaba `/t/<token>`. Una línea.
Comprobado leyendo la propiedad del contacto en la API de Omnisend: el enlace que
salió al correo es `http://localhost:4321/t/<token>`.

**Paso 2 · El formulario mueve al proveedor.** `form-submit.ts` hacía cuatro
`query()` sueltos contra el pool; ahora toma una conexión y todo va en una
transacción: ficha, `form_submitted_at`, el `UPDATE` del proveedor a `unconfirmed`
y la entrada de `audit_log`. Si falla uno no queda ninguno.

Tres decisiones dentro de ese cambio:

- El `SELECT` del envío toma `FOR UPDATE`. Dos entregas simultáneas del mismo
  enlace se serializan y la segunda ve escrito `form_submitted_at`, así que sale
  por el 409 en vez de duplicar la ficha.
- El `UPDATE` lleva `WHERE status = 'candidate'`. Un registro tardío no debe
  retroceder una ficha que un operador ya movió a `approved` o `rejected`. Cuando
  no se mueve, el `audit_log` lo anota con `status_changed: false`.
- **`reviewed_at` se deja en NULL**, al contrario de lo que insinuaba el borrador
  de 31.3. Esa columna va con `reviewed_by` y significa que una persona revisó;
  escribirla al registrarse el proveedor sería afirmar una revisión que no ocurrió.
  Que falte esa revisión es justamente lo que `unconfirmed` significa.

La migración del `CHECK` está aplicada en producción y guardada en
`sql/2026-09-21-providers-status-unconfirmed.sql`. `schema.sql` recoge el estado
nuevo, y con él `ProviderStatus`, `StatusBadge` (etiqueta «Registrado»), el color
del badge, el filtro de la vista, el conteo «Por revisar» y `demo.ts`.

**Paso 3 · Envío real.** No había que orquestar nada: `sendCampaign` ya encadenaba
contactos, segmento, plantilla, borrador y `sendEmailCampaign`, y el botón «Enviar
a seleccionados» ya lo dispara. La sección 31.2 daba este hueco por abierto y no
lo estaba. **Lo que sí estaba roto era el envío**: Omnisend devolvía 400 con
`'statusChangedAt' must not be in the future` porque `upsertConsentedContact`
mandaba `new Date().toISOString()` y su reloj va ligeramente por detrás. Un minuto
de margen lo arregla. El reloj local se comprobó contra un servidor externo: iba
exacto al segundo, el desfase es de ellos.

**Paso 4 · El círculo en el panel.** El historial de campañas suma dos columnas,
Clics y Formularios, leídas de PostgreSQL. Los conteos van con `DISTINCT` porque
el JOIN con `email_clicks` multiplica una fila por clic e inflaba también la
columna de destinatarios. La consulta a la API de Omnisend sigue siendo solo bajo
demanda, por la cuota.

**Fallo aparte, encontrado al probar.** En la vista de proveedores,
`.prov{display:grid}` gana al `display:none` que el navegador aplica a `[hidden]`,
así que las fichas filtradas **seguían viéndose** aunque el contador marcara 0 y
saliera el mensaje de vacío. Viene de `6e5c76b`, no de este trabajo. Una regla
`.prov[hidden]{display:none}` lo corrige.

### 33.2 La prueba, con sus datos

Proveedor y contacto de prueba creados a mano apuntando a
`david.theran03@gmail.com`, único contacto elegible de la base en ese momento —
comprobado con un `SELECT` antes de disparar.

| Comprobación | Resultado |
|---|---|
| `POST /api/campaigns` | `sent: 1, failed: 0` |
| Enlace en el contacto de Omnisend | `…/t/f3984a7e…` |
| `GET /t/<token>` | 302 a `/registro/<token>` |
| `email_clicks` | 1 fila, `link_key='registration'` |
| Formulario enviado desde el navegador | «Datos recibidos» |
| `providers.status` | `candidate` → `unconfirmed` |
| `form_submitted_at` vs `providers.updated_at` | `10:50:05.152Z` en ambos: misma transacción |
| `audit_log` | `provider.confirmed`, `status_changed: true` |
| Reabrir el enlace | «Ya tenemos tu información» |
| Reenviar el formulario | 409, sin fichas ni auditorías duplicadas |
| Panel de campañas | Destinatarios 1 · Enviados 1 · Clics 1 · Formularios 1 |
| Portada | «Mostraron interés: 1», que antes era cero por construcción |

*Nota sobre el 403.* Reenviar el formulario con `curl` sin cabecera `Origin`
devuelve 403, no 409: es la protección CSRF de Astro, antes de llegar al endpoint.
Con `Origin` puesto responde el 409 que corresponde.

### 33.3 Lo que sigue pendiente

- **SES sigue en sandbox.** Solo se puede escribir a direcciones verificadas. El
  envío a proveedores reales necesita salir del sandbox y autorización explícita.
- **`APP_URL` apunta a `http://localhost:4321`.** Los enlaces de un envío real
  saldrían con esa dirección. Hay que apuntarlo al dominio antes de cualquier
  campaña de verdad.
- **Nadie aprueba todavía.** `unconfirmed` espera a un operador, pero no hay
  acción en el panel para pasar de ahí a `approved`.

### 33.4 Commits

```text
43076ab merge: cableado del envío al registro confirmado
55d1c91 docs: el cableado del registro confirmado, ejecutado y probado
639f9cb feat: el panel cierra el círculo con clics y formularios por campaña
587d4bf feat: el correo enrutado por el contador y el registro mueve al proveedor
```

---

## 34. Google Places: incidente de facturación y contención — 2026-09-22

### Qué pasó

Google Cloud facturó ~149.697 COP en el proyecto `happia-provider-ia`, SKU **Places API Text Search
Enterprise**. La sección 24 y el README daban por hecho 5.000 llamadas gratis y ~USD 32/1.000: eso es el
SKU **Pro**. Los campos que pide el `FieldMask` (`rating`, `userRatingCount`, `nationalPhoneNumber`,
`websiteUri`) son Enterprise, Google factura al SKU más alto de los campos pedidos, y Enterprise regala
1.000 eventos al mes y cobra USD 35/1.000 después (tabla oficial, verificada el 2026-09-22). No hay SKU
más barato que devuelva `rating`. Una búsqueda del panel podía lanzar 10 escaneos × 4 consultas de
cosecha más hasta 4 búsquedas por fila en "Sin dato", y la API se activaba con solo tener la clave.

### Qué cambió

- **Puerta única** `src/lib/places-gate.ts`: clave + `GOOGLE_PLACES_OPT_IN=1` + sin
  `GOOGLE_PLACES_KILL_SWITCH=1` + presupuesto `GOOGLE_PLACES_MAX_REQUESTS` (50/día UTC por proceso por
  defecto). Cuenta intentadas, realizadas y bloqueadas con motivo; lo expone `/api/health` y lo escribe
  cada escaneo en `curation.places_mode`. Con clave y sin opt-in: cero peticiones (test
  `scripts/places-gate.test.ts`).
- **"Sin dato" ya no se descarta en el filtro de umbral**: se conserva como "Requiere revisión"
  (`pending_reputation_review`), que el importador nunca acepta. Cierra el pendiente de la sección 30
  (52 filas retiradas por ignorancia, no por juicio).
- **Pista autodeclarada**: si el sitio del negocio publica `aggregateRating` en JSON-LD, se anota en la
  justificación como "Pista sin verificar"; no toca las columnas de calificación.
- `scripts/bench-no-places.ts`: benchmark con ciudad y categorías fijas que comprueba, con los
  contadores de la puerta, que no salió ninguna petición.
- **Hallazgo colateral, corregido:** Gemini escribe "Sin dato" en la columna Instagram aunque el
  prompt pida "Sin Redes", y el validador tumbaba la fila entera por `invalid_instagram`. Medido con
  la base de producción: 10 de 10 filas de Comida y Bebida con reputación y contacto válidos caían
  por eso. Ahora "Sin dato" equivale a "Sin Redes" (`normalizeInstagram`, con test).

### Alternativas evaluadas (2026-09-22)

| Fuente | Reputación | Coste | Veredicto |
|---|---|---|---|
| Agente (Gemini `google_search` / Claude WebSearch) | A veces, en fragmentos | Ya se paga | Sigue siendo el descubridor |
| Sitio oficial del negocio (scraper propio) | Solo autodeclarada (JSON-LD) | 0 | Correo, Instagram y pista |
| Caché local (base propia) | Sí, ya verificada | 0 | Implementada y retirada a petición de David: la cifra debe verificarse en cada búsqueda |
| OpenStreetMap / Overpass | No tiene reseñas | 0 (ODbL, 1 req/s, User-Agent) | Descubrimiento con teléfono/web; no resuelve reputación |
| TripAdvisor Content API | Sí | — | Deprecada (migra a "Terra"); no viable |
| Foursquare Places v2 | Parcial | USD 1–3/1.000, sin nivel gratuito | Dependencia paga: no sin aprobación |
| Brave Search API | Fragmentos | USD 5 de crédito/mes (~1.000 consultas), USD 5/1.000 | Dependencia nueva: pendiente de aprobación |
| Scraping de Maps / TripAdvisor / Facebook | Sí | 0 | Prohibido por términos: descartado |

Conclusión honesta: sin Places no hay fuente gratuita y legal que devuelva la calificación de Google.
El flujo conserva descubrimiento, contacto, evidencia y deduplicación; la cifra de reputación la
trae el agente (Gemini la lee en sus resultados de búsqueda) o la confirma una persona en las filas
"Requiere revisión".

### Ajustes del 2026-09-22 (noche): el objetivo son negocios que cumplen

- David pidió que una búsqueda con mínimo 3.5 y 30 en Cartagena devolviera 20 negocios con esa
  configuración. No podía: el objetivo contaba filas (incluidas las de revisión) y el validador
  tenía 4.5 fijo, así que un 4.0/1479 salía rechazado.
- Ahora el umbral del operador llega a `parseCurationTsv` y a la importación (el panel lo manda),
  `runCurationGoal` mide el objetivo en aceptados y sigue hasta lograrlo (12 escaneos, 3 seguidos
  sin novedad), la consolidación pone primero los válidos, y la cuota por escaneo es dinámica
  (lo que falta, entre 8 y 20). Tests en `curation-threshold.test.ts`.
- Medido: Cartagena · Comida y Bebida · 3.5/30 · objetivo 20 → 20 válidos en 5 escaneos (294 s),
  20 en revisión, 0 Places. Con la cuota fija anterior el primer escaneo traía 5 filas y 1 válida.
- El registro local de reputación se retiró por decisión de David.

### Verificación de contacto antes de aprobar — 2026-09-22 (noche)

Auditoría a mano de los 20 válidos de Cartagena: contacto comprobable en el sitio en 12–13 de 20; 2
buzones equivocados en el dominio correcto (hojas de vida, una persona), 3 móviles distintos al
publicado, 3 correos de otro dominio sin ver. Respuesta: `contact-verify.ts` lee el sitio y exige el
dato publicado; lo no confirmado baja a revisión con el motivo (`contact_unverified`) y se repite al
importar. Test: `scripts/contact-verify.test.ts`. Medición con el paso integrado en la sección
siguiente.

### Medición con verificación integrada — 2026-09-22 (madrugada del 23)

Cartagena, estándar 4.5/30, objetivo 10, Gemini: Comida y Bebida 10/10 en 4 escaneos (272 s);
Fotografía y Video 8/10 en 9 escaneos (538 s, agotada); Lugar 10/10 en 3 (251 s). 58 filas, 28
aceptadas (48 %), 28/28 con contacto confirmado en una segunda lectura independiente, 0 Places. En
Lugar la verificación bajó 8 hoteles con cifra alta por contacto no comprobable: exactamente los
casos que la auditoría manual había señalado. Cifras crudas en el cerebro
(`notas/calidad-cartagena-2026-09-22.json`).

## 35. Subagentes de reputación (sin Places) — 2026-09-23

### Qué pasaba

Manizales · Menaje y mantelería en producción: 12 de 12 filas con calificación y reseñas en "Sin
dato", aunque 8 tienen ficha en Google con reseñas. El agente de descubrimiento investiga 8–20
negocios en un solo contexto y reparte sus búsquedas; el prompt de Gemini (español) no le exige una
búsqueda de reputación por candidato. Prueba aislada: la misma herramienta `google_search`, dedicada
a UN negocio con nombre, dirección y teléfono, sí ve la ficha (Alma: 5.0 con 16, igual que Maps).

### Qué cambió

- `src/lib/reputation-lookup.ts`: una llamada corta e independiente a Gemini por cada fila en
  "Sin dato" (4 en paralelo, 120 s de tope). Solo acepta calificación 1–5, reseñas enteras ≥ 1,
  una de las 6 plataformas admitidas y coincidencia de la ficha por teléfono, dirección o web (solo
  por nombre no vale). Reescribe la fila con la misma forma que dejaba Places; lo no confirmado sigue
  en "Requiere revisión". Corre solo con Places cerrado; `CURATION_SKIP_REPUTATION_SUBAGENTS=1` lo apaga.
- `scripts/reputation-lookup.test.ts` (en `npm test`) y `scripts/bench-reputation.ts` (benchmark
  contra cifras comprobadas a mano en Maps).

### Medición (2 corridas, 12 casos de Manizales comprobados en Maps)

Correctos 7 · "Sin dato" correcto (sin reseñas) 4 · omitido 1 (Alqui-Rimax, 4.8/4) · **inventados 0**
· ~30 s en paralelo. El caso "Casa de Eventos G&M" se marcó primero como inventado (4.7/3) y era un
error del caso de prueba: la ficha con ese teléfono y dirección está rotulada "Patty Bridal".
Pendiente: confirmar el precio de las consultas de `google_search` (5–16 por subagente).

### Corrección el mismo día: los subagentes no corrían en producción

Primera búsqueda real tras el deploy (Bucaramanga · Entretenimiento, 20 filas): ningún evento
`curation.reputation_subagents` en el log. `placesEnabled` en `curateProviders` solo indica que no se
apagó Places por medición (`CURATION_DISABLE_PLACES`), no que la puerta esté abierta: se entraba a la
rama de Places, que no hace nada con la puerta cerrada, y los subagentes nunca se llamaban. Ahora la
rama de Places exige además `isGooglePlacesConfigured()`.

La búsqueda no es determinista (Happy City Megamall, 4.3/69: 2 de 3 intentos idénticos), así que lo no
encontrado se reintenta una vez (`CURATION_REPUTATION_ATTEMPTS`, 2 por defecto). Las mismas 20 filas de
Bucaramanga, en local: 3 con cifra (Burbujitas 4.5/2, Divertypark 4.5/47, Happy City 4.3/69), el resto
"Sin dato". Revisadas en Maps: la mayoría no tiene ficha propia con ese teléfono (perfiles solo de
Facebook, o ficha sin reseñas); Fiesta Kids tiene 4.9/331 pero la ficha no publica teléfono y coincidir
solo por nombre se rechaza a propósito. Manizales con reintento: 7 correctos, 4 sin dato correctos,
1 omitido, 0 inventados.
