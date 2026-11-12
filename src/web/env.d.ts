/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const c: DefineComponent<{}, {}, any>
  export default c
}

/** Set by the desktop app's preload (desktop/preload.cjs); absent in a browser. */
interface Window {
  deckDesktop?: { on(cb: (cmd: string) => void): void }
}
