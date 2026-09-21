/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Origen del backend. Vacío o ausente significa "el mismo origen". */
  readonly BACKEND_URL?: string;
  /** Token de servicio con el que el proxy del frontend se identifica ante el backend. */
  readonly BACKEND_SERVICE_TOKEN?: string;
  readonly [key: `PUBLIC_${string}`]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
