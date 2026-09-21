# Marketplace Control
# proovedores

Panel interno para revisar proveedores candidatos, campañas de contacto y formularios recibidos.

## Arranque local

```bash
npm install
copy .env.example .env
npm run dev
```

Sin `DATABASE_URL`, la interfaz usa datos de demostración y sigue permitiendo revisar el flujo visual.

En esta sesión el panel está corriendo en `http://127.0.0.1:4321/` conectado al PostgreSQL remoto. La contraseña del usuario técnico no se guardó en el proyecto; para reiniciar el panel hay que inyectar `DATABASE_URL` desde un gestor de secretos o una variable de entorno segura.

## Separación frontend / backend

El repositorio contiene dos aplicaciones:

| | Dónde vive | Qué sirve | Despliegue |
|---|---|---|---|
| **Backend** | raíz del repo | solo `/api/**` y `/t/:token` | EC2, por el workflow de siempre |
| **Frontend** | `frontend/` | todas las páginas del panel | Vercel |

El frontend no tiene acceso a PostgreSQL ni a ninguna credencial de servicio externa: todo lo pide
por HTTP a `/api/v1/*` del backend, autenticándose con `BACKEND_SERVICE_TOKEN`.

```bash
npm run dev                  # backend  -> http://127.0.0.1:4321 (solo API)
npm run dev --prefix frontend  # panel  -> http://127.0.0.1:4322
```

El `frontend/.env` necesita `BACKEND_URL` y `BACKEND_SERVICE_TOKEN`. Sin `BACKEND_URL`, el proxy
responde 503 diciéndolo en vez de fallar en silencio.

### Por qué hay un proxy en el frontend

Los scripts de las páginas llaman a rutas del mismo origen (`/api/ai/curation`, `/api/campaigns`…).
Con el panel en Vercel esas rutas no existen ahí, así que `frontend/src/pages/api/[...path].ts`
reenvía cualquier `/api/*` al backend **añadiendo el token del lado del servidor**. Las alternativas
—llamar al backend desde el navegador o reescribir cada `fetch`— obligan a CORS y dejan el token de
servicio a la vista en el JavaScript de la página.

### Al separar los dominios

`FRONTEND_URL` en el backend es obligatorio: `/t/:token` registra el clic del correo y redirige al
formulario, que ya no se sirve desde el backend. Sin esa variable, el proveedor acaba en un 404.

## PostgreSQL

`sql/schema.sql` crea el esquema `marketplace` de forma idempotente. El esquema ya fue aplicado en la instancia EC2 de marketplace y sus tablas fueron verificadas.

Para conectar la aplicación, define `DATABASE_URL` con la credencial guardada en el servidor. No la subas al repositorio ni la uses con prefijo `PUBLIC_`.

## Datos cargados

Primer lote importado desde `C:\Users\davidt\Downloads\omnisend-playground\leads_barranquilla.csv`: 25 proveedores de Barranquilla, 25 fuentes y 9 contactos. Los contactos quedaron con `consent_status = unknown`; no son elegibles para campañas hasta obtener consentimiento.

## Flujos MVP

- `/proveedores`: candidatos, búsqueda, estados e importación estricta del TSV de 20 columnas de curaduría (incluye reputación multiplataforma y categorías adicionales).
- `/proveedores/:id`: evidencia y siguiente acción.
- `/t/:token`: registra clic con token opaco y envía al formulario.
- `/registro/:token`: formulario público con consentimiento separado.
- `/formularios`: bandeja de respuestas para revisión humana.
- `/campanas`: composición y envío por Omnisend con confirmación explícita; solo se muestran contactos con consentimiento de marketing concedido y sin supresión.
- Gemini: el panel permite escoger ciudad y categoría, genera una vista previa de curaduría, separa empresas para correo corporativo de empresas para WhatsApp, valida el TSV localmente y solo importa proveedores como `candidate` después de una confirmación explícita.

La primera versión no convierte un correo público en permiso de marketing: los contactos descubiertos por curaduría quedan en `unknown`. Solo el formulario público con la casilla de marketing marcada los vuelve elegibles para una campaña.

## Envío de campañas (Omnisend)

El envío real de campañas (`/api/campaigns`, `sendCampaign` en `src/lib/campaigns.ts`) y la prueba QA
(`/api/campaigns/qa-test`) usan exclusivamente **Omnisend**; no hay ninguna dependencia de AWS SES en
el código (el SDK `@aws-sdk/client-sesv2` fue removido de `package.json`).

Cada destinatario recibe contenido único (su propio enlace de registro con token de tracking), y
Omnisend no tiene un endpoint de "correo transaccional suelto": el envío real crea una plantilla y un
borrador de campaña por destinatario (`importEmailTemplate` + `createEmailCampaignDraft`) y lo entrega
con `sendEmailCampaignTest` (el único endpoint de Omnisend que acepta una lista explícita de
direcciones en vez de un segmento de audiencia). Con un lote de N contactos esto crea N campañas en el
panel de Omnisend; es intencional, no un error.

Variables relevantes: `OMNISEND_API_KEY`, `OMNISEND_SENDER_NAME`, `OMNISEND_SENDER_EMAIL` (remitente
verificado en la cuenta; `info@happia.co` es el que ya está verificado), `OMNISEND_REPLY_TO_EMAIL`
(opcional), y `QA_TEST_RECIPIENTS`/`QA_TEST_RECIPIENT` para la prueba QA.

## Seguridad pendiente antes de producción

- Configurar `ADMIN_ACCESS_KEY` y terminar autenticación por roles/sesiones.
- Cambiar el fallback `sslip.io` por `marketplace.sempertex.com` cuando el DNS real apunte a una Elastic IP estable.
- Configurar rebotes, quejas, bajas y lista de supresión del lado de Omnisend.
- Eliminar la regla antigua del Security Group cuando ya no sea necesaria; durante esta sesión se añadió `204.199.82.34/32` a 22 y 5432 para acceso temporal.

## Curaduría con Claude Code

El agente de curaduría lanza el CLI de Claude Code con `spawn`. Tres detalles del arranque no son
opcionales y hay pruebas que los protegen:

- `stdio[0]` va en `'ignore'`. Cerrar stdin con `.end()` depende de un turno libre del event loop y,
  con el servidor ocupado, el CLI alcanza a escribir `Warning: no stdin data received in 3s` en
  stderr. Ese aviso es informativo: el CLI continúa y termina con código 0.
- `--strict-mcp-config` evita cargar los servidores MCP de la cuenta. Sin él, cada proceso arranca
  con 197 herramientas en vez de 30 y tarda ~1.7s más.
- `--allowedTools` **no restringe nada**: es una lista de auto-aprobación. La restricción real es
  `--disallowedTools`, que aquí deniega `Task` (para que el agente no cree sus propios subagentes),
  `Bash`, `Write` y el resto de herramientas locales.

Cuando el CLI se queda sin turnos, el evento `result` llega con `subtype: "error_max_turns"`,
`is_error: true` y **sin** campo `result`. Ese caso se reporta como `CLAUDE_CODE_MAX_TURNS`; nunca se
debe atribuir el fallo al contenido de stderr.

Cada ejecución escribe una línea JSON `curation.claude_run` con job, escaneo, PID, comando sin
secretos, duración, conteo de WebSearch/WebFetch, último evento, código de salida y motivo del fallo.

### Proveedor alterno: Codex CLI

Con `CURATION_PROVIDER=codex` (`.env`), la curaduría lanza `codex exec --json` en vez de Gemini o
Claude Code. Detalles del arranque:

- El prompt viaja por **stdin** (`.write()` + `.end()`), nunca por argv: así el argv de Codex solo
  contiene literales fijos (`model`, `reasoningEffort`) y el texto libre de la curaduría no puede
  romper el comando. Sin stdin, Codex se queda esperando `Reading additional input from stdin...`.
- En Windows, `codex` se instala como shim `.cmd` y Node no puede ejecutarlo directamente
  (`EINVAL`); hace falta `shell: true`. Eso solo es seguro porque `model` y `reasoningEffort` se
  validan contra una lista blanca (`SAFE_CODEX_TOKEN`) antes de entrar al argv: Node no escapa los
  argumentos cuando `shell` está activo.
- El sandbox `--sandbox read-only` es el equivalente a `--disallowedTools`: impide que el agente
  escriba archivos o ejecute comandos; Codex no tiene una lista de herramientas denegadas explícita.
- Codex expone una sola herramienta de búsqueda web (`web_search`) con dos acciones —`search` y
  `open_page`— en vez de `WebSearch`/`WebFetch` separadas. Por eso el descubrimiento amplio en dos
  fases con subagentes (Barranquilla · Comida y Bebida) sigue siendo exclusivo de Claude Code; Codex
  siempre usa la investigación de un solo turno.
- `CODEX_MODEL` y `CODEX_REASONING_EFFORT` (por defecto `gpt-5.6-luna` y `medium`) se pasan como
  `-m` y `-c model_reasoning_effort="..."`. El fallo real llega en el evento `turn.failed` o en un
  `error` de nivel superior, con el detalle anidado como una cadena JSON dentro de `message`.
- Codex usa un prompt propio (`codexPrompt`, en inglés, distinto del prompt compartido en español de
  Gemini/Claude Code). Con esfuerzo `medium` y el prompt compartido, el agente no verificaba
  reputación antes de responder (buscaba poco y devolvía "Sin dato" aunque el dato existiera
  públicamente). `codexPrompt` añade un protocolo obligatorio y numerado: antes de incluir cualquier
  candidato, hacer una búsqueda dedicada solo para su reputación (no basta con la búsqueda general de
  descubrimiento), y solo usar "Sin dato" si esa búsqueda dedicada realmente no encuentra nada. Con
  esto, `medium` confirma reputación real en ~65s por escaneo quality-comparable a `xhigh` (~7 min)
  para categorías con reputación pública (ej. restaurantes). Para categorías sin reputación pública
  estructurada (ej. artistas/orquestas), sigue devolviendo "Sin dato" correctamente tras buscarlo: eso
  es el comportamiento esperado de `validateCurationBatch` (`src/lib/curation.ts`), no una falla del
  prompt.
- El mismo protocolo también corrigió un bug de formato: el prompt original decía que el ID debía
  tener el patrón `ABC-CC-###` sin aclarar que "ABC" era un placeholder, y el modelo lo copiaba
  literal (`ABC-02-001`, `ABC-02-002`, ...) en vez de generar tres letras propias por negocio. El
  prompt de Codex ahora lo prohíbe explícitamente y da un ejemplo concreto.

### Comandos

```bash
npm test                          # pruebas de validación, conteo y runner (lanza el CLI real)
npm run test:unit                 # solo las pruebas puras, sin red
npm run curation:smoke -- "Barranquilla" "Comida y Bebida" 20
npm run curation:release-blacklist -- "Barranquilla" "Comida y Bebida"          # simulación
npm run curation:release-blacklist -- "Barranquilla" "Comida y Bebida" --apply  # libera
```

`SKIP_CLI_TESTS=1` omite las pruebas que lanzan el binario de Claude Code.

### Lista negra

Un candidato rechazado no se vuelve a buscar. La excepción son los motivos que describen un fallo de
la herramienta de investigación, no del negocio: `not_returned_by_verification`, `pending_reputation_review`
y `missing_review_disclosure`. Estos solo bloquean dentro de la misma ejecución (`run_id`) y se pueden
reintentar en la siguiente. Al prompt solo viajan nombres; las URLs, los códigos y los motivos se
quedan en la base de datos y los aplica el servidor.

### Estándar de reputación

Un candidato listo necesita **calificación mínima 4.5 y 30 reseñas exactas en una sola plataforma**,
sin distinción por tipo de proveedor (`src/lib/curation.ts`). Nivel A = 50+ reseñas; Nivel B = 30-49
o reputación combinada.

**Reputación combinada:** si ninguna plataforma sola llega a 30 reseñas, el candidato igual pasa si
2 o más plataformas con calificación 4.5+ suman **60 o más** reseñas combinadas. Esto vive en la
columna 19 del TSV, "Reputación Multiplataforma" (`Plataforma:Calificación:Reseñas;...`), que registra
TODAS las plataformas encontradas, no solo la mejor. La justificación debe decir "reputación
combinada" y el total exacto cuando aplica este camino; si no, `invalid_curation_reason` la rechaza.

**Google Places API:** Google Maps renderiza su calificación con JavaScript y no la expone como texto
rastreable — confirmado empíricamente que ni una búsqueda web genérica ni un fetch directo a Maps la
muestran, aunque exista y sea visible para una persona. Por eso ningún prompt lo soluciona. Con
`GOOGLE_PLACES_API_KEY` configurada (`src/lib/google-places.ts`), cualquier fila que quede en "Sin
dato" se reintenta después del escaneo contra la API oficial de Google Places (Text Search), que
devuelve `rating`/`userRatingCount` como datos estructurados; si encuentra algo, reescribe
calificación, reseñas, plataforma, nivel y justificación de la fila, y suma la entrada de Google a la
columna multiplataforma. Sin la key, esta corrección es un no-op silencioso. Precio real (2026): 5,000
llamadas gratis al mes con Text Search, ~$32/1000 adicionales — muy por encima del volumen que genera
esta app.

La ficha de proveedor (`/proveedores/:id`) y la lista (`/proveedores`) muestran el desglose de
reputación por plataforma leyendo `marketplace.provider_sources`, que guarda una fila por plataforma
observada (no solo la principal).
