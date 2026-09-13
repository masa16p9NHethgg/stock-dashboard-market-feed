# Stock Dashboard Market Feed

公開市場データを取得し、portfolio-specificな識別子だけを使って暗号化feedを生成する専用リポジトリです。

このリポジトリには、口座情報、保有数量、取得原価、損益、配当、SBI原本、実在銘柄コードと秘密鍵を保存しません。GitHub Actions secretsからのみ、32-byte AES keyとopaqueなfeed_id→市場シンボル対応表を受け取ります。

公開artifactは `market-feed.enc.json` の暗号文だけです。復号はowner-onlyな株式投資ダッシュボード側で行います。

## Required GitHub Actions secrets

- `MARKET_FEED_KEY_B64`: 32-byte random key, Base64 encoded
- `PORTFOLIO_SYMBOL_MAP_JSON`: `{ "feed_id": "market symbol" }` のみ。保有数量・口座・原価・損益・配当は含めない

## Safety

The scheduled workflow is read-only against the market data provider. It does not access brokerage accounts and never prints secrets or decrypted payloads.
