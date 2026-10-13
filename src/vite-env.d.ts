/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_HTR_FRONT_DOOR?: string; // "1": the try-it front door (Tony's hosted demo); otherwise a closed door
}
