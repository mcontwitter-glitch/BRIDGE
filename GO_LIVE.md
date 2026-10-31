# Ordinals bridge go-live checklist

Prepared 2026-10-31. **Nothing on this list has been run.** Do the steps in order; each step only runs after the one before it has confirmed.
Prices used: ETH ≈ $2,239, BTC ≈ $77,245, Arbitrum 0.02 gwei, Abstract 0.045 gwei, BTC 1 sat/vB (mempool.space, 2026-10-31 03:45 EDT).

## Readiness (read-only check, 2026-10-31)
| Item | Status |
|---|---|
| Vault owner / LZ delegate `0xb19F00e095B1387061d73751C772bbA848D196b1` | **Key not on this box.** BIG signs every owner step in his own wallet. |
| `0xb19F…96b1` on Abstract | 0.00307 ETH (nonce 80). Enough for B1 and B2. |
| `0xb19F…96b1` on Arbitrum One | **0 ETH.** Needs about 0.0005 ETH for A1/A2 (and the deploy, if it deploys). |
| Other EVM keys on the box | `0x5c05…a08C` (foot-mainnet-deployer), `0x0F84…be4F`, `0x9eD7…eAf`, `0xEfE2…773E`, `0x5744…8880`. All have 0 ETH on Arbitrum and Abstract, so none can deploy. |
| Inscriber `bc1pua8x…mmg9` (key in `~/.bridge-ordinals/mainnet.key`, chmod 600) | **0 sats**, no transactions. |
| Cloudflare token (`CLOUDFLARE_API_TOKEN`) | Can see zones `bigfoot404.biz` and `multisea.io`, and Worker scripts. **DNS read is denied.** No `ordinals` Worker or route exists yet. |

## 1. Deploy `OrdinalsSink` on Arbitrum One
- **Who signs:** any funded wallet. The deployer gets no power over the sink, because the delegate is a constructor argument. The simplest choice is `0xb19F…96b1`.
- **Cost:** 570,808 gas (`cast estimate`, including the L1 data part) ≈ 0.0000114 ETH ≈ **$0.03**.
```bash
cd /workspace/BRIDGE && export PATH="$HOME/.foundry/bin:$PATH"
forge script script/DeployOrdinalsSink.s.sol --rpc-url https://arb1.arbitrum.io/rpc   # dry run (the script never broadcasts)
# Real deploy, run on the signer's machine (Ledger, or --interactive; never a key on the command line):
forge create src/ordinals/OrdinalsSink.sol:OrdinalsSink --rpc-url https://arb1.arbitrum.io/rpc --ledger --broadcast \
  --constructor-args 0x1a44076050125825900e736c501f859c50fE728c 30324 0xe81DdAB112137112B8FeeB853e22BC4c38F999e5 0xb19F00e095B1387061d73751C772bbA848D196b1
export SINK=0x...   # the deployed address
cast call $SINK "srcEid()(uint32)" --rpc-url https://arb1.arbitrum.io/rpc   # must print 30324
```

## 2. Re-encode the owner calls with the real sink
```bash
ORDINALS_SINK=$SINK forge script script/DeployOrdinalsSink.s.sol --rpc-url https://arb1.arbitrum.io/rpc
```
This reverts unless `$SINK` is a real sink wired to the Abstract vault. It then prints the final A1/A2/B1/B2 calldata and simulates A1/A2 as the delegate.

## 3. A1 + A2 on Arbitrum (sink receive config)
- **Who signs:** `0xb19F…96b1` (the sink's delegate), sending to EndpointV2 `0x1a44076050125825900e736c501f859c50fE728c`.
- **Cost:** about 180k gas ≈ **$0.01**.
```bash
cast send 0x1a44076050125825900e736c501f859c50fE728c <A1 calldata> --rpc-url https://arb1.arbitrum.io/rpc --ledger   # setReceiveLibrary(sink, 30324, ReceiveUln302 0x7B9E…05e6, 0)
cast send 0x1a44076050125825900e736c501f859c50fE728c <A2 calldata> --rpc-url https://arb1.arbitrum.io/rpc --ledger   # setConfig: 20 confirmations, LZ Labs DVN 0x2f55…6416
```
A2 is required. Without it, Arbitrum's default DVN for Abstract is the dead placeholder and messages never verify.

## 4. B1 on Abstract (vault send config)
- **Who signs:** `0xb19F…96b1` (vault owner), sending to the vault `0xe81DdAB112137112B8FeeB853e22BC4c38F999e5`.
- **Cost:** 563,308 gas ≈ 0.0000253 ETH ≈ **$0.06**.
```bash
cast send 0xe81DdAB112137112B8FeeB853e22BC4c38F999e5 "setSendConfig(address,uint32,uint64,address,uint32,address)" \
  0x166CAb679EBDB0853055522D3B523621b94029a1 30110 20 0xF4DA94b4EE9D8e209e3bf9f469221CE2731A7112 10000 0x643E1471f37c4680Df30cF0C540Cd379a0fF58A5 \
  --rpc-url https://api.mainnet.abs.xyz --ledger
```

## 5. Host the delivery service (Cloudflare Worker), still closed
- **Who approves:** BIG approves the deploy. The account is Mcontwitter@gmail.com's.
- **Cost:** Workers + Durable Objects (SQLite) work on the free plan. **Workers Paid ($5/mo) is recommended**, because the free plan's 10 ms CPU limit per request is tight for Taproot signing in JS.
```bash
cd /workspace/BRIDGE/ordinals-delivery/worker && npm ci && npm test && npm run dry-run
npx wrangler secret put ORDINALS_INSCRIBER_WIF < ~/.bridge-ordinals/mainnet.key   # reads from the file, never echoed
# In wrangler.toml: uncomment the route `ordinals.bigfoot404.biz` (custom domain). Leave ORDINALS_SINK_ADDRESS unset for now → POST answers 503.
npx wrangler deploy
curl -s https://ordinals.bigfoot404.biz/api/ordinals/health   # keyConfigured:true, sink:null
```
The custom domain needs a token allowed to edit DNS / Workers custom domains on `bigfoot404.biz`; the current token can't read DNS. An alternative is a route on an existing hostname, e.g. `bridge.bigfoot404.biz/api/ordinals/*`, which only works if that hostname is proxied through Cloudflare. GitHub Pages is not, so `ordinals.` is the clean option.

## 6. Collection setup (layers + renderer, inscribed once)
- **Who approves:** BIG funds the inscriber and approves the spend.
- **Cost:** 98 inscriptions, 419,572 B ≈ 195,907 sats ≈ **$151 at 1 sat/vB**. The cost grows linearly with the fee rate.
- **Funding:** send about **250,000 sats** to `bc1pua8xnvy6cx7g632g3rx8gy5z9qg5s446d267gkzgenmsd6ewkwasrsmmg9`. That covers setup plus a buffer for deliveries (about 1,110 sats ≈ $0.86 each at 1 sat/vB).
```bash
cd /workspace/BRIDGE/ordinals-delivery
npm run setup:collection                 # dry run: plan + cost
npm run setup:collection -- --broadcast  # resumable; writes collections/lil-foots.manifest.json when complete
cd worker && npx wrangler deploy         # re-bundles the manifest (health → setup: inscribed)
```

## 7. Open the route (B2), last on-chain step
- **Who signs:** `0xb19F…96b1`, sending to the vault.
- **Cost:** 378,534 gas ≈ 0.000017 ETH ≈ **$0.04**.
```bash
cast send 0xe81DdAB112137112B8FeeB853e22BC4c38F999e5 "setPeer(uint32,bytes32)" 30110 $(cast abi-encode "f(address)" $SINK) --rpc-url https://api.mainnet.abs.xyz --ledger
cast call 0xe81DdAB112137112B8FeeB853e22BC4c38F999e5 "peers(uint32)(bytes32)" 30110 --rpc-url https://api.mainnet.abs.xyz   # == sink
```

## 8. Turn the service and the page on, then push
```bash
cd /workspace/BRIDGE/ordinals-delivery/worker
# wrangler.toml [vars]: ORDINALS_SINK_ADDRESS = "$SINK"
npx wrangler deploy && curl -s https://ordinals.bigfoot404.biz/api/ordinals/health   # destEid 30110
```
In `docs/index.html`, before `assets/ordinals.js`:
```html
<script>window.BRIDGE_ORDINALS_URL="https://ordinals.bigfoot404.biz";window.BRIDGE_ORDINALS_SINK="0x...";</script>
```
Commit as mcontwitter-glitch with no trailers. Push only after BIG says "Push"; GitHub Pages then serves Bridge.bigfoot404.biz.

## Totals and order of approvals
- **EVM:** about $0.15 total. That needs about 0.0005 ETH on Arbitrum for `0xb19F…96b1` (it has 0), and Abstract is already funded.
- **BTC:** about $151 at 1 sat/vB, plus about $0.86 per delivery.
- **Cloudflare:** $0–5/mo.
- **BIG signs:** deploy, A1, A2, B1 and B2 (five EVM transactions), plus the BTC funding transfer. **BIG approves:** the Worker deploy (with the WIF secret), the collection-setup spend, and the final push.
- **Return path (Ordinal → EVM):** not supported. A foot sent to Ordinals stays locked in the vault (see `ordinals-delivery/ORDINALS_SINK.md`).
