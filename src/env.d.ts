/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly DATABASE_URL?: string;
  readonly SESSION_SECRET?: string;
  readonly TRACKING_SECRET?: string;
  readonly ADMIN_ACCESS_KEY?: string;
  readonly APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
