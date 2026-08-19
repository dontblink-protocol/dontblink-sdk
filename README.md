# @dontblink/sdk

Launch tokens on [dontblink](https://dontblink.community) (Robinhood Chain, 4663) from code.

**You keep your key.** This package builds the transaction correctly — right params per
mode, vanity salt, and the stock-quoting tick that fails silently if you get it wrong.
Signing and broadcasting happen with your own viem wallet. There is no server in the
middle and nothing to trust us about.

```bash
npm i @dontblink/sdk viem
```

---

## Launch a token

```ts
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { launch, instantParams, DEFAULT_RPC } from '@dontblink/sdk'

const account = privateKeyToAccount(process.env.PK as `0x${string}`)
const publicClient = createPublicClient({ transport: http(DEFAULT_RPC) })
const walletClient = createWalletClient({ account, transport: http(DEFAULT_RPC) })

const { token, pool, vanity } = await launch({
  publicClient,
  walletClient,
  params: instantParams({ name: 'My Token', symbol: 'MTK' }),
  options: { onProgress: console.log },
})

console.log(token) // 0x…dbdb
```

That is the whole thing. Supply is fixed at 1B, all of it goes single-sided into a
Uniswap V3 pool in the same transaction, and the LP position is minted straight into
a lock contract that has no withdrawal path. You pay the launch fee and gas, nothing else.

---

## The four modes

```ts
import { instantParams, curveParams, queueParams, stockQuotedParams } from '@dontblink/sdk'
```

| Builder | What it does |
|---|---|
| `instantParams` | Pool exists the same second. The default. |
| `curveParams` | Trades on a bonding curve first; graduates into a pool inside the buy that crosses the threshold. |
| `queueParams` | Window where everyone queues, then one clearing price for all of them. |
| `stockQuotedParams` | Paired with a tokenized stock instead of ETH — see below. |

Use the builder rather than assembling `LaunchParams` yourself. `launch` takes 21 fields
and several of them are the kind where a wrong value **does not revert** — it just
produces a token that behaves differently than you meant.

---

## Priced in a stock

Your token can trade against NVDA or TSLA instead of ETH. The opening range has to be
derived from that stock's own ETH pool:

```ts
import { launch, stockQuotedParams, stockMagnitude } from '@dontblink/sdk'

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'
const { magnitude, info } = await stockMagnitude(publicClient, NVDA)

console.log(`pricing off a pool with ${Number(info.wethDepth) / 1e18} WETH in it`)

await launch({
  publicClient, walletClient,
  params: stockQuotedParams({ name: 'NVDA Cat', symbol: 'NCAT', quote: NVDA, startTickMagnitude: magnitude }),
})
```

**Do not reuse the ETH magnitude for a stock-quoted launch.** The pool opens roughly
ten times away from where you meant, the chain accepts it without reverting, and you
find out from the chart. `stockMagnitude` reads the live tick of the stock's ETH pool
and refuses outright if that pool is thinner than 1 WETH — a pool that shallow can be
shoved by anyone willing to spend pocket change, and your opening price goes with it.

There is no published Chainlink feed for these assets on this chain (checked
2026-08-19), so the pool *is* the price. That is also why only a few stocks are
usable rather than the forty-odd a venue quoting off-chain can list.

---

## Vanity addresses

Every token launched through the website ends in `…dbdb`. That suffix is **mined, not
granted** — the frontend tries salts until the predicted address matches. Calling
`launch` on the contract with a random salt gets you a random address, which is why
tokens launched by hand don't have it.

`launch` mines one by default. To control it:

```ts
await launch({
  publicClient, walletClient, params,
  options: { vanitySuffix: 'dbdb', vanityBudgetMs: 15_000 },
})
```

Each extra hex character multiplies the expected work by 16: four characters is ~65k
tries and lands in well under a second, six is ~16.7M and takes minutes. If the budget
runs out the SDK falls back to a random salt and sets `vanity: false` on the result —
a nice address should never be the reason a launch fails.

**The salt is bound to your wallet.** The contract mixes `creator` into it so nobody
can front-run your address by copying the salt out of your pending transaction. The
flip side: a salt mined for one wallet is worthless to another.

Mining it yourself:

```ts
import { mineVanitySalt, predictToken } from '@dontblink/sdk'
const { salt, address, vanity, tries } = mineVanitySalt(myAddress, { suffix: 'dbdb' })
```

---

## The address check

Before broadcasting, the SDK asks the contract's own `predictToken` whether it agrees
with the address computed locally, and throws if it doesn't. Local derivation and the
contract differing by a single byte means your token lands somewhere else — and by then
you have already paid. Skip it with `options: { verify: false }` if you are batching and
have already verified once.

---

## Reference

**Contracts**

| | |
|---|---|
| Portal (proxy, permanent) | `0x7a4EB7F99833178c6463184bd0D8d17b6FC2d59c` |
| Token implementation (v1) | `0xbdB3695972c977488F3B45607FF35432B5497702` |
| LP lock | `0x137f67344563cC98b0E2A5Ee644849bc846E070D` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

**`launch()` returns**

```ts
{ token, pool, txHash, salt, vanity }
```

Keep `salt` — it is what makes the launch reproducible if you ever need to explain how
an address came about. `pool` is the zero address for a curve launch until it graduates.

**Fees.** The launch fee is read from the contract at call time; the SDK sends exactly
that and nothing more. Sending extra ETH does not buy you the first trade — the contract
refunds the surplus. A first buy is a separate transaction after the launch.

---

## What this package deliberately does not do

It does not sign for you, hold your key, or run a server. Some launchpads offer an API
where one HTTP call creates the token because they sign on your behalf; that is a
different trade and it means trusting the operator.

Everything dontblink claims is meant to be checkable without asking us: the LP lock has
no withdrawal function in its bytecode, the treasury ledger is public and its sweep is
permissionless, and the adversarial tests are in the open. An endpoint that signs for
users would quietly add a "trust us" step to a product built to not need one.

BUSL-1.1
