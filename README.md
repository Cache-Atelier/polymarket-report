# Polymarket Report

A Drudge Report-style front page for the future, powered by prediction markets.

An LLM reads live Polymarket data — prices, volume, whale trades, resolution status — and writes punchy headlines ranked by newsworthiness. The result is a single-page briefing that tells you what the world thinks is about to happen.

**Live site**: [polymarketreport.com](https://polymarketreport.com)

## How it works

A scheduled script pulls market data from Polymarket's APIs, assembles an editorial briefing, and sends it to Claude Opus via OpenRouter. The model selects up to 28 stories, writes headlines, flags the most dramatic ones in red, and groups related stories together. The output is served as a static JSON file and rendered in a three-column newspaper layout.

Headlines update automatically twice daily.

## Contact

[@onchaindom](https://x.com/onchaindom)
