// Extra secret rules (spec, Secret scan item 2), next to the bundled gitleaks
// rules and in the same shape, so one matcher runs both:
// - OpenAI project, service account and admin keys without the `T3BlbkFJ`
//   marker that the gitleaks `openai-api-key` rule requires;
// - Stripe webhook signing secrets (`whsec_`), which gitleaks has no rule for;
// - the credential pattern of `create-mercato-module` (src/repository-safety.ts
//   at main f83233d) as a floor, split into one rule per family so a finding
//   names what matched. The floor keeps the gitleaks allowlist of the same
//   family where gitleaks has one (AWS keys ending in `EXAMPLE`, the
//   documentation value in the stock `.env.example`).
//
// The ids are part of the report (`findings[].ruleId`): never rename one.
import type { BundledRule } from './gitleaks.js'

function rule(id: string, source: string, keywords: string[], allowlists: BundledRule['allowlists'] = []): BundledRule {
  return { id, regex: { source, flags: '' }, secretGroup: 0, entropy: null, keywords, path: null, allowlists }
}

export const extraRules: readonly BundledRule[] = Object.freeze([
  rule('openai-api-key-unmarked', '\\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}', ['sk-proj-', 'sk-svcacct-', 'sk-admin-']),
  rule('stripe-webhook-secret', '\\bwhsec_[A-Za-z0-9]{24,}', ['whsec_']),
  rule('floor-private-key', '-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----', ['-----begin']),
  rule('floor-github-token', '\\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})', ['github_pat_', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']),
  rule('floor-npm-token', '\\bnpm_[A-Za-z0-9]{30,}', ['npm_']),
  rule('floor-aws-access-key', '\\b(?:AKIA|ASIA)[0-9A-Z]{16}', ['akia', 'asia'], [
    { condition: 'OR', regexTarget: 'secret', regexes: [{ source: 'EXAMPLE$', flags: '' }], stopwords: [] },
  ]),
  rule('floor-stripe-live-key', '\\b[sr]k_live_[0-9A-Za-z]{20,}', ['sk_live_', 'rk_live_']),
  rule('floor-slack-token', '\\bxox[abprs]-[0-9A-Za-z-]{10,}', ['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-']),
  rule('floor-google-api-key', '\\bAIza[0-9A-Za-z_-]{35}', ['aiza']),
])
