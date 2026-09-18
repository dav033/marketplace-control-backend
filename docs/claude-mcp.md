# Conectar el marketplace a Claude por MCP/SSH

Esta primera versión usa MCP sobre `stdio`. Claude ejecuta `ssh` localmente y
ese proceso mantiene stdin/stdout conectado al servidor MCP en EC2:

```text
Claude Desktop o Claude Code
        │ proceso local: ssh -T
        │ stdin/stdout = JSON-RPC MCP
        ▼
EC2: /usr/local/bin/marketplace-control-mcp
        │ carga /etc/marketplace-control/marketplace-control.env
        ▼
node /srv/marketplace-control/current/mcp-server/dist/index.js
```

No se abre un puerto MCP público y no se copia `DATABASE_URL` al equipo local.
El wrapper remoto la carga desde el archivo de entorno protegido de EC2.

## Prerrequisitos

En EC2 debe haberse ejecutado al menos un deploy exitoso después de instalar el
bootstrap del proyecto. Deben existir:

- `/usr/local/bin/marketplace-control-mcp`.
- La clave pública del usuario en `~/.ssh/authorized_keys`.
- `DATABASE_URL` en `/etc/marketplace-control/marketplace-control.env`, con permisos `0600`.
- La regla sudoers que permite ejecutar únicamente el wrapper con `sudo -n`.
- El commit desplegado debe contener el MCP compilado en `current/mcp-server/dist/index.js`.

En Windows, guarda la clave privada fuera del repositorio, por ejemplo:

```text
C:\Users\TU_USUARIO\.ssh\marketplace-aws
```

No pegues la clave, la contraseña de PostgreSQL ni `DATABASE_URL` en este
archivo, en Claude, en GitHub ni en un prompt.

## Comprobación SSH antes de configurar Claude

Registra la host key de EC2 desde una máquina confiable y conserva
`StrictHostKeyChecking=yes`. Después prueba solo el puente, sin abrir una
sesión interactiva:

```powershell
ssh -T `
  -o BatchMode=yes `
  -o StrictHostKeyChecking=yes `
  -o IdentitiesOnly=yes `
  -i "C:\Users\TU_USUARIO\.ssh\marketplace-aws" `
  ec2-user@TU_EC2_HOST `
  sudo -n /usr/local/bin/marketplace-control-mcp
```

El comando queda esperando stdin porque es un servidor stdio. Cancélalo con
`Ctrl+C` después de confirmar que no devuelve un error de SSH, sudo o Node. No
debe escribirse ningún diagnóstico en stdout; los mensajes de diagnóstico van
a stderr.

La plantilla lista para copiar está en
`deploy/mcp-client-config.example.json`. Cambia solamente la ruta local de la
clave y el host de EC2.

## Claude Desktop en Windows

Para una instalación que admita configuración JSON de servidores MCP locales:

1. Abre `%APPDATA%\Claude\claude_desktop_config.json`.
2. Conserva los servidores que ya existan y añade el bloque de `mcpServers` de la plantilla.
3. Sustituye `C:/Users/YOU/.ssh/marketplace-aws` por la ruta real de tu clave y `YOUR_EC2_HOST` por el DNS o IP de EC2.
4. Guarda el archivo y reinicia Claude Desktop por completo.
5. Abre una conversación nueva y comprueba que aparecen `search_providers`, `get_provider`, `pipeline_stats`, `list_registration_submissions` e `import_curated_providers`.

El bloque debe conservar esta forma, sin `DATABASE_URL`:

```json
{
  "mcpServers": {
    "marketplace-control": {
      "command": "ssh",
      "args": [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-i",
        "C:/Users/TU_USUARIO/.ssh/marketplace-aws",
        "ec2-user@TU_EC2_HOST",
        "sudo",
        "-n",
        "/usr/local/bin/marketplace-control-mcp"
      ]
    }
  }
}
```

Algunas versiones recientes de Claude Desktop priorizan Settings > Extensions
para servidores locales y Settings > Connectors para servidores MCP remotos.
Este proyecto no es un conector HTTP remoto: es un proceso local `ssh` que
transporta MCP por stdio, por lo que debe configurarse como servidor local si
esa opción está disponible en tu versión.

## Claude Code

La forma más sencilla es registrar el comando stdio en el alcance del usuario.
Ejecuta PowerShell desde una terminal donde `claude` esté instalado:

```powershell
claude mcp add --scope user marketplace-control -- `
  ssh -T `
  -o BatchMode=yes `
  -o StrictHostKeyChecking=yes `
  -o IdentitiesOnly=yes `
  -i "C:\Users\TU_USUARIO\.ssh\marketplace-aws" `
  ec2-user@TU_EC2_HOST `
  sudo -n /usr/local/bin/marketplace-control-mcp
```

Verifica el registro:

```powershell
claude mcp get marketplace-control
claude mcp list
```

También puedes usar un `.mcp.json` de alcance de proyecto, pero ese archivo se
comparte con el repositorio y por eso no debe contener una clave privada,
`DATABASE_URL` ni tokens. Si lo usas, conserva la ruta de la clave como una
ruta local que solo exista en tu equipo y revisa el archivo antes de hacer
commit. Claude Code pide aprobación para servidores definidos a nivel de
proyecto; acepta la conexión solo después de revisar el comando completo.

## Flujo de curaduría recomendado

1. Pide a Claude que ejecute el prompt de curaduría para una sola ciudad y categoría.
2. Haz que convierta la salida a JSON estructurado según `mcp-server/README.md`.
3. Llama `import_curated_providers` sin `confirm` o con `confirm: false`.
4. Revisa cantidad, ciudad, categoría, URLs, umbrales, correos y duplicados en la respuesta dry-run.
5. Solo después de tu aprobación explícita, repite el mismo lote con `confirm: true`.
6. Comprueba los resultados con `search_providers`, `get_provider` y `pipeline_stats`.

La importación deja todos los proveedores como `candidate`. Un correo se guarda
como contacto con consentimiento `unknown`; no se concede permiso de marketing
por el hecho de haber encontrado un correo público. El servidor MCP no ofrece
ninguna herramienta para enviar o programar campañas.

## Problemas frecuentes

- `Permission denied (publickey)`: revisa usuario, ruta de clave y `authorized_keys`; no desactives `BatchMode`.
- `Host key verification failed`: registra y revisa la host key en `known_hosts`; no uses `StrictHostKeyChecking=no`.
- `sudo: a password is required`: falta la regla sudoers exacta del wrapper.
- `DATABASE_URL no está configurada`: el archivo externo de EC2 está vacío o el wrapper no lo está cargando.
- Claude no muestra herramientas: reinicia el cliente y prueba primero el comando SSH manual; confirma que stdout solo contiene JSON-RPC.
- `VALIDATION_FAILED`: corrige el lote; no intentes saltarte los umbrales, las URLs de búsqueda, el nivel de curaduría o el campo `confirm`.

Referencias oficiales de Anthropic:

- [MCP en Claude Code](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Referencia CLI de Claude Code](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Servidores MCP locales en Claude Desktop](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
