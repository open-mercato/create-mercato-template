# Stock fixtures

`0.9.0.json` is an independent copy of two facts of the `create-mercato-app` 0.9.0 tarball on npm (its `integrity` is in the file), taken by hand rather than by `scripts/build-stock-table.mts`, so `test/stock.test.cjs` can check the generated table against it:

- `envExample`: the exact text of `template/.env.example`;
- `credentialUrls`: the sorted, unique `scheme://user:password@host` strings with a non-empty password found in any text file under `template/` (`grep -rhIoE` over the unpacked tarball).

The text is stored as a JSON string with non-ASCII characters escaped, like `src/stock/table.json`, so the committed files stay plain ASCII. Refresh it only when the 0.9.0 tarball changes, which npm does not allow.
