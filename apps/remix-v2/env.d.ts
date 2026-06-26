/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PUBLIC_HTTP_API?: string;
  readonly PUBLIC_WEBSOCKET_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
