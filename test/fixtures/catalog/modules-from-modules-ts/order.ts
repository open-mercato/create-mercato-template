export type ModuleEntry = { id: string; from?: string }

const shared: ModuleEntry[] = [
  { id: 'shared_one', from: '@acme/shared' },
  { id: 'shared_two', from: '@acme/shared' },
]

export let enabledModules: ModuleEntry[] = [{ id: 'auth', from: '@open-mercato/core' }, ...shared]

enabledModules.unshift({ id: 'dashboards', from: '@open-mercato/core' })
enabledModules = [{ id: 'first', from: '@app' }, ...enabledModules, { id: 'last', from: '@app' }]

for (const entry of shared) {
  if (!enabledModules.some((existing) => existing.id === entry.id)) enabledModules.push(entry)
}

export const moduleCount = enabledModules.length
export const hasAuth = enabledModules.some((entry) => entry.id === 'auth')
