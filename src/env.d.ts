/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly DATABASE_URL?: string;
  readonly SESSION_SECRET?: string;
  readonly TRACKING_SECRET?: string;
  readonly ADMIN_ACCESS_KEY?: string;
  readonly APP_URL?: string;
  readonly AWS_REGION?: string;
  readonly SES_FROM_EMAIL?: string;
  readonly SES_REPLY_TO_EMAIL?: string;
  readonly SES_CONFIGURATION_SET?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_AGENT_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
