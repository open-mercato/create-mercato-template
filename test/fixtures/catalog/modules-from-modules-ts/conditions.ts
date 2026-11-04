import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'

export type ModuleEntry = { id: string; from?: string }

export const enabledModules: ModuleEntry[] = [
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'example', from: '@app' },
]

const enterprise = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES, false)
const sso = parseBooleanWithDefault(process.env.OM_ENABLE_ENTERPRISE_MODULES_SSO, false)

if (enabledModules.some((entry) => entry.id === 'example')) {
  enabledModules.push({ id: 'example_customers_sync', from: '@app' })
}

if (!process.env.OM_DISABLE_LEGACY) {
  enabledModules.push({ id: 'legacy_import', from: '@app' })
} else {
  enabledModules.push({ id: 'modern_import', from: '@app' })
}

if (enterprise) {
  enabledModules.push({ id: 'record_locks', from: '@open-mercato/enterprise' })
  if (sso) {
    enabledModules.push({ id: 'sso', from: '@open-mercato/enterprise' })
  }
}

if (enterprise && process.env['OM_ENABLE_REPORTS']) {
  enabledModules.push({ id: 'reports', from: '@acme/reports' })
} else {
  enabledModules.push({ id: 'reports_lite', from: '@acme/reports' })
}

if (process.env.OM_A === '1' || process.env.OM_B) {
  enabledModules.push({ id: 'either', from: '@app' })
}

if (sso) {
  if (featureFlag('beta')) enabledModules.push({ id: 'beta_sso', from: '@app' })
}

declare function featureFlag(name: string): boolean
