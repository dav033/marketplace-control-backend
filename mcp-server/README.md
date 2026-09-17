# Marketplace Control MCP Server

Mini-servidor MCP, TypeScript/Node, transporte `stdio`, para consultar el pipeline de proveedores del proyecto `marketplace-control`.

## Herramientas

- `search_providers`: texto, categoría, ciudad, estado y límite.
- `get_provider`: proveedor por UUID y fuentes públicas asociadas.
- `pipeline_stats`: conteos por estado; sin datos personales.
- `list_registration_submissions`: registros del formulario, con correo y teléfono enmascarados por defecto.

Todas son de solo lectura. SQL siempre parametrizado. Límite máximo: 100 filas. `form_payload` y credenciales nunca salen por MCP.

## Configuración

Requiere Node 20+ y una única variable de conexión:

```powershell
$env:DATABASE_URL = "postgresql://USUARIO:CONTRASENA@HOST:5432/marketplace"
npm install
npm run check
npm start
```

`DATABASE_URL` se usa exclusivamente para PostgreSQL. No se leen variables `PUBLIC_*`. No pongas credenciales en Git, README, logs ni configuración pública.

## Configuración MCP local

El cliente MCP debe ejecutar el binario compilado y proporcionar `DATABASE_URL` mediante su gestor de secretos o entorno privado:

```json
{
  "mcpServers": {
    "marketplace-control": {
      "command": "node",
      "args": [
        "C:\\Users\\davidt\\Desktop\\marketplace-control\\mcp-server\\dist\\index.js"
      ],
      "env": {
        "DATABASE_URL": "<usar secreto del entorno; no commitear>"
      }
    }
  }
}
```

El servidor escribe únicamente mensajes MCP en `stdout`; diagnósticos van a `stderr`.

## Verificación

Desde esta carpeta:

```powershell
npm run build
npm run smoke
npm run check
```

El smoke test valida handshake MCP y las cuatro herramientas sin conectarse a una base real. Para probar consultas reales, define `DATABASE_URL` y ejecuta el cliente MCP.

Esquema usado: `marketplace.providers`, `provider_sources`, `registration_submissions`, `contacts`, `campaign_sends` y `email_clicks`, sin modificarlo.
