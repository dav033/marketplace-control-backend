/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly DATABASE_URL?: string;
  readonly SESSION_SECRET?: string;
  readonly TRACKING_SECRET?: string;
  readonly ADMIN_ACCESS_KEY?: string;
  readonly LOCAL_AUTO_LOGIN?: string;
  readonly APP_URL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_AGENT_MODEL?: string;
  readonly CURATION_PROVIDER?: string;
  readonly CLAUDE_CODE_PATH?: string;
  readonly CLAUDE_CODE_MODEL?: string;
  readonly CODEX_CLI_PATH?: string;
  readonly CODEX_MODEL?: string;
  readonly CODEX_REASONING_EFFORT?: string;
  readonly GOOGLE_PLACES_API_KEY?: string;
  readonly OMNISEND_API_KEY?: string;
  readonly OMNISEND_VERSION?: string;
  readonly OMNISEND_SENDER_NAME?: string;
  readonly OMNISEND_SENDER_EMAIL?: string;
  readonly OMNISEND_REPLY_TO_EMAIL?: string;
  readonly QA_TEST_RECIPIENT?: string;
  readonly QA_TEST_RECIPIENTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
