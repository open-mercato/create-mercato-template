# gitleaks fixture

A byte-for-byte copy of `config/gitleaks.toml` of `gitleaks/gitleaks` at tag `v8.30.1`, the input of `scripts/build-secret-rules.mts` (spec Step 6). `test/secret-rules.test.cjs` reads it; no test fetches it.

| File | Tag | sha256 |
| --- | --- | --- |
| `gitleaks.toml` | `v8.30.1` | `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf` |

Fetched on 2026-11-03 from `https://raw.githubusercontent.com/gitleaks/gitleaks/v8.30.1/config/gitleaks.toml`, the URL the script uses. The script pins the same sha256 and refuses any other content. A test checks the hash, and a test checks that the committed `src/rules/gitleaks.json` is exactly the conversion of this file.

gitleaks is MIT licensed (Copyright (c) 2019 Zachary Rice). Refresh this file only together with the pinned tag and sha256 in the script, by copying the new tag's file and running `npm run secret-rules -- --input test/fixtures/gitleaks/gitleaks.toml`.
