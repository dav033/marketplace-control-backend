# Migración a dos repositorios independientes

Estado de partida: un solo repositorio con dos aplicaciones ya separadas en carpetas
(`/` backend, `/frontend` panel). El objetivo es que cada una viva en su propio repositorio, se
despliegue sola y se pueda probar sin la otra.

Lo que **ya está resuelto** y no hay que rehacer: el backend no sirve páginas, el frontend no toca
PostgreSQL ni credenciales, la comunicación es HTTP con token de servicio, y el proxy del frontend
evita CORS y mantiene el token del lado del servidor.

---

## 1. Los tres acoplamientos que quedan

Son los únicos obstáculos reales. Todo lo demás es mover archivos.

### 1.1 El frontend importa código del backend

```
frontend/src/pages/**.astro  →  ../../../../src/lib/api-client
frontend/src/pages/api/[...path].ts  →  ../../../../src/lib/contract
```

`contract.ts` arrastra además `types.ts` y `demo.ts`. Son cuatro archivos.

**Decisión necesaria: cómo se comparte el contrato entre dos repos.**

| Opción | Coste | Riesgo |
|---|---|---|
| **A. Copia en cada repo** | Nulo | Se separan con el tiempo sin que nadie lo note |
| B. Paquete npm privado | Publicación, versionado, CI extra | Bajo, pero añade una pieza que mantener |
| C. Submódulo git | Sin publicación | Los submódulos se olvidan de actualizar; peor que A en la práctica |

**Recomendado: A, con una prueba de contrato que compense el riesgo.** Son tipos y dos constantes;
un paquete npm para eso es más maquinaria de la que aporta. El riesgo de que se separen se cubre en
2.4 con una prueba que valida la forma real de la respuesta del backend. Si el backend cambia el
contrato, esa prueba falla en el frontend — que es exactamente lo que un `import` compartido habría
detectado, solo que en ejecución en vez de al compilar.

### 1.2 Una prueba del backend inspecciona archivos del frontend

`scripts/agent-identity.test.ts` recorre `frontend/src/{pages,components,layouts}` para comprobar
que la interfaz no nombra ningún motor de IA. **Esa prueba se parte en dos**: la parte de mensajes
se queda en el backend, la de plantillas se va al frontend.

### 1.3 Un módulo de dominio importa desde una ruta

`src/lib/registration-chat.ts` importa `parseList`, `parseVolume` y `OFFICIAL_CATEGORIES` desde
`src/pages/api/public/form-submit.ts`. Es interno del backend, así que **no bloquea la separación**,
pero conviene arreglarlo en la misma tanda: la validación del formulario es dominio, no ruta.

---

## 2. Fases

Cada fase deja el sistema funcionando. No se pasa a la siguiente sin que la anterior verifique.

### Fase 0 — Red de seguridad (antes de tocar nada)

1. Etiquetar el commit actual: `git tag pre-split-repos && git push --tags`.
2. Anotar la release desplegada en EC2: `ls -l /srv/marketplace-control/current`.
   Hoy es `02e1f051`, **anterior a todo el trabajo de separación**: nada de lo que hay en el árbol
   está desplegado todavía. El primer `push` a `main` llevará de golpe el backend sin páginas, así
   que conviene que Vercel ya esté sirviendo el panel antes de ese push.
3. Confirmar que la suite pasa entera y que ambos builds funcionan.

**Verificación:** `npm test` (17 archivos de prueba), `npm run build`, `npm run build --prefix frontend`.

### Fase 1 — Limpiar acoplamientos, todavía en un solo repo

Se hace aquí porque es reversible y verificable con la suite completa antes de dispersar el código.

1. Extraer la validación del formulario a `src/lib/registration-fields.ts`
   (`parseList`, `parseVolume`, `OFFICIAL_CATEGORIES`) y que `form-submit.ts` y `registration-chat.ts`
   importen de ahí. Actualizar `scripts/registro-form.test.ts`.
2. Mover `api-client.ts` a `frontend/src/lib/api-client.ts` — es código del frontend, no del backend.
3. Copiar `contract.ts`, `types.ts` y `demo.ts` a `frontend/src/lib/`, y que el frontend importe de
   su propia copia. El backend conserva las suyas.
4. Partir `agent-identity.test.ts` según 1.2.
5. Recortar `frontend/src/env.d.ts` a lo que el frontend usa de verdad:
   `BACKEND_URL`, `BACKEND_SERVICE_TOKEN`, `PUBLIC_*`.

**Verificación:** `grep -r "\.\./\.\./\.\./" frontend/src` no devuelve nada. Los dos builds pasan.
La suite del backend pasa sin la carpeta `frontend/` presente:

```bash
mv frontend /tmp/frontend-tmp && npm test && npm run build ; mv /tmp/frontend-tmp frontend
```

Esa última comprobación es la que demuestra que el backend ya no depende del frontend.

### Fase 2 — Crear el repositorio del frontend

1. `marketplace-control-frontend` en GitHub, vacío.
2. Llevar `frontend/` con su historia:
   ```bash
   git subtree split --prefix=frontend -b frontend-split
   git push git@github.com:<org>/marketplace-control-frontend.git frontend-split:main
   ```
   Con `subtree split` la historia de esos archivos viaja con ellos. Un `cp` la perdería.
3. En el repo nuevo: subir `astro.config.mjs`, `package.json` y `tsconfig.json` a la raíz, y añadir
   `README.md` propio con cómo arrancarlo contra un backend local.
4. Vercel apunta al repo nuevo, *Root Directory* en la raíz. Variables: `BACKEND_URL` y
   `BACKEND_SERVICE_TOKEN`.

**Verificación:** clonar el repo nuevo en una carpeta limpia, `npm ci`, `npm run build` y
`npm run dev` contra el backend local. Tiene que funcionar sin que el repo del backend exista en esa
máquina.

### Fase 3 — Dejar el backend solo

1. Borrar `frontend/` del repositorio original.
2. Renombrar el repo a `marketplace-control-backend` (GitHub mantiene las redirecciones).
3. Ajustar `README.md`: apunta al repo del frontend y explica que este ya no sirve páginas.
4. El workflow de despliegue **no se toca**: sigue construyendo desde la raíz.

**Verificación:** `find src/pages -name "*.astro"` devuelve vacío. El despliegue a EC2 funciona y
`/api/health` responde 200.

### Fase 4 — Separar los dominios

El orden importa: si se invierte, los enlaces de los correos quedan rotos.

1. **Primero**, en `/etc/marketplace-control/marketplace-control.env` de la EC2:
   - `FRONTEND_URL=https://<dominio-del-panel>` — sin esto, `/t/:token` manda a los proveedores a un
     404 del backend.
   - `BACKEND_SERVICE_TOKEN=<valor>` — hoy no está en el servidor; sin él, `/api/v1/*` responde 503.
   - `APP_URL` pasa a ser el dominio del panel.
2. Reiniciar: `sudo systemctl restart marketplace-control`.
3. **Después**, en Vercel: `BACKEND_URL=https://<dominio-del-backend>` con el mismo
   `BACKEND_SERVICE_TOKEN`.
4. Sustituir el apaño `sslip.io` del Caddyfile por el dominio real del backend.

**Verificación:** un enlace `/t/:token` real acaba en el formulario del panel; un envío de ese
formulario vuelve a guardar en PostgreSQL.

---

## 3. Pruebas: cómo quedan repartidas

### Backend (los 17 archivos actuales; `agent-identity` se queda solo con su mitad)

Sin cambios de contenido salvo los ajustes de la Fase 1. Corren sin red y sin base salvo
`whatsapp-store.test.ts`, que se salta sola cuando no hay `DATABASE_URL`.

### Frontend (nuevas, hoy no existen)

Hay que escribirlas; el frontend se va sin ninguna prueba propia y eso no es aceptable.

1. **`proxy.test.ts`** — que el proxy añada el token, no reenvíe cabeceras salto a salto, conserve el
   303 del formulario y responda 503 sin `BACKEND_URL`. Con un backend simulado, sin red.
2. **`api-client.test.ts`** — que cada `fetch*` caiga a datos de demostración cuando el backend no
   responde, y que un 404 devuelva `null` en vez de inventar una ficha.
3. **`ui-identity.test.ts`** — la mitad que se trae del backend: ninguna plantilla `.astro` nombra un
   motor de IA.
4. **`contract.test.ts`** — la que compensa la copia del contrato. Llama al backend real con el token
   y valida que la respuesta de cada `/api/v1/*` tiene los campos que el frontend espera. Se salta
   sola si no hay `BACKEND_URL`, para no atar el CI a que el backend esté levantado.

---

## 4. Criterios de finalización

La migración está terminada cuando **todo** esto se cumple:

**Independencia**
- [ ] Clonado en limpio, cada repo instala, compila y pasa sus pruebas sin el otro presente.
- [ ] `grep -r "\.\./\.\./\.\./" frontend/src` no devuelve nada en el repo del frontend.
- [ ] El repo del backend no contiene ningún `.astro`.
- [ ] Ninguna prueba de un repo lee archivos del otro.

**Funcionamiento**
- [ ] El panel en Vercel muestra datos reales, sin el aviso de «Modo demostración».
- [ ] Las 10 páginas responden 200.
- [ ] El chat de prueba completa un registro y la ficha aparece en PostgreSQL.
- [ ] Un enlace `/t/:token` lleva al formulario del panel y su envío se guarda.
- [ ] `/api/health` del backend responde 200 tras un despliegue nuevo.

**Seguridad**
- [ ] El token de servicio no aparece en el HTML ni en el JavaScript servido por el frontend.
- [ ] `/api/v1/*` responde 401 sin token y 200 con él.
- [ ] El frontend no declara ni usa ninguna credencial de base, Omnisend, Gemini, Places o WhatsApp.

**Operación**
- [ ] Un `git push` a cada repo despliega solo su parte.
- [ ] Rollback probado: mover el symlink `current` a la release anterior deja el backend sirviendo.
- [ ] El `README` de cada repo explica cómo arrancarlo y contra qué.

---

## 5. Riesgos

| Riesgo | Cuándo aparece | Mitigación |
|---|---|---|
| **Enlaces de campaña rotos** | Al separar dominios sin `FRONTEND_URL` | Fase 4, paso 1 primero. Probar un `/t/:token` real antes de anunciar nada |
| **El contrato se separa** | Semanas después, en silencio | `contract.test.ts` en el frontend |
| **`/api/v1/*` devuelve 503 en producción** | Si falta `BACKEND_SERVICE_TOKEN` en EC2 | Añadirlo antes de apuntar Vercel al backend real |
| **El panel queda sin proteger** | Vercel no tiene el Basic Auth del middleware del backend | **Decidir antes de publicar**: el panel es interno y hoy lo protege el middleware que se queda en el backend. Hace falta autenticación propia en el frontend o restringir por red |
| **Perder la historia de los archivos** | Si se copia en vez de `git subtree split` | Fase 2, paso 2 |

---

## 6. Lo que esta migración deja pendiente a propósito

No son parte de separar los repos, pero conviene tenerlos a la vista:

- El panel en Vercel **no tiene autenticación propia**. Es el punto del cuadro de riesgos que hay que
  resolver antes de que sea público.
- `curation-job` sigue guardando su estado en memoria: un despliegue a mitad de una curaduría la
  pierde. WhatsApp ya está en PostgreSQL; esto no.
- El agente del chat usa el CLI de Codex, **que no está instalado en la EC2**. En producción el bot
  responde solo con mensajes fijos.
- `gemini.ts` son 1.815 líneas que mezclan el agente de curaduría y el runner del chat.
