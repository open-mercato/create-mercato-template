export type ModuleEntry = { id: string; from?: string }

const extraId = 'computed_extra'

export const enabledModules: ModuleEntry[] = [
  { id: 'auth', from: '@open-mercato/core' },
  { id: extraId, from: '@app' },
  { id: 'Bad_Id', from: '@app' },
  { id: 'remote', from: 'https://user:secret@example.com/x.git' },
  pickModule(),
]

function addExtras(list: ModuleEntry[]) {
  list.push({ id: 'extra', from: '@app' })
}
addExtras(enabledModules)
enabledModules.push(...buildMore())
enabledModules.push(process.env.OM_X ? { id: 'x_on', from: '@app' } : { id: 'x_off', from: '@app' })
enabledModules.splice(0, 1)
for (const entry of enabledModules) entry.from = '@app'

declare function pickModule(): ModuleEntry
declare function buildMore(): ModuleEntry[]
