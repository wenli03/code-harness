/// <reference types="vite/client" />

import type { CodeHarnessApi } from '@shared/api'

declare global {
  interface Window {
    pi: CodeHarnessApi
  }
}

export {}
