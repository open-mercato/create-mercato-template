export type ModuleEntry = { id: string; from?: string }

export const enabledModules: ModuleEntry[] = [
  { id: 'auth' },
  { id: 'customers', from: '@open-mercato/core' },
  { id: 'quotes_portal', from: '@app' },
  { id: 'crm_sync', from: '@acme/crm-sync' },
  { id: 'local_alias', from: './vendor/local-alias' },
]

const s3 = Boolean(process.env.OM_ENABLE_STORAGE_S3)
if (s3) {
  enabledModules.push({ id: 'storage_s3', from: '@open-mercato/storage-s3' })
}
