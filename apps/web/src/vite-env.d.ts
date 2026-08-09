/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** Deployed commit SHA baked at build time. */
  readonly VITE_GIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
