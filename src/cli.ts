#!/usr/bin/env node
// dontblink 只读 CLI v0：新发射列表、费用、风险标签。
//
// 没有任何写操作：不发币、不买卖、不签名，也不读私钥。写操作等测试网就绪后单独加，
// 而且只放测试网。规矩见 read.ts 文件头：不排序、不推荐、不做"即将毕业"查询、限频。

import { createPublicClient, formatEther, http } from 'viem'
import { DEFAULT_RPC, CHAIN_ID } from './core.js'
import { getFees, listLaunches, MAX_LIMIT } from './read.js'

const HELP = `dontblink — read-only (Robinhood Chain ${CHAIN_ID})

  dontblink launches [--limit N] [--lookback-blocks N] [--json]
      Newest launches first. Facts + risk tags only; no ranking, no recommendations.
      --limit            1-${MAX_LIMIT}, default 20
      --lookback-blocks  only scan this many recent blocks (~10 blocks/s)
  dontblink fees [--json]
      Current protocol fees (launch fee, trade fee, referrer share, creator LP share).

  --rpc URL   default ${DEFAULT_RPC} (or env DONTBLINK_RPC)

No write commands. Nothing here signs or touches keys.`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP)
    return
  }
  const json = args.includes('--json')
  const rpc = flag(args, '--rpc') ?? process.env.DONTBLINK_RPC ?? DEFAULT_RPC
  const client = createPublicClient({ transport: http(rpc) })

  if (cmd === 'fees') {
    const f = await getFees(client)
    if (json) {
      console.log(JSON.stringify({ ...f, launchFee: f.launchFee.toString() }, null, 2))
      return
    }
    console.log(`launch fee        ${formatEther(f.launchFee)} ETH`)
    console.log(`trade fee         ${f.tradeFeeBps / 100}% (charged once, on primary buys)`)
    console.log(`referrer share    ${f.referrerShareBps / 100}% of protocol fees, settled on-chain`)
    console.log(`creator LP share  ${f.creatorLpBps / 100}% of LP fees after the pool opens`)
    return
  }

  if (cmd === 'launches') {
    const limit = Number(flag(args, '--limit') ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`--limit must be 1-${MAX_LIMIT}`)
    const lb = flag(args, '--lookback-blocks')
    if (lb !== undefined && !/^[1-9][0-9]*$/.test(lb)) throw new Error('--lookback-blocks must be a positive integer')
    const rows = await listLaunches(client, { limit, lookbackBlocks: lb ? BigInt(lb) : undefined })
    if (json) {
      console.log(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
      return
    }
    if (!rows.length) {
      console.log('No launches in range.')
      return
    }
    for (const r of rows) {
      const when = new Date(r.time * 1000).toISOString().replace('T', ' ').slice(0, 16)
      const fee = r.fees.tradeFeeBps === null ? 'unknown' : `${r.fees.tradeFeeBps / 100}%`
      console.log(`${when}Z  ${r.symbol ?? '?'}  ${r.mode}  quote=${r.quoteSymbol ?? '?'}  trade-fee=${fee}  ${r.token}`)
      console.log(`    tags: ${r.riskTags.join(', ') || '-'}`)
    }
    console.log(`\n${rows.length} launches, newest first. Not a ranking or a recommendation.`)
    return
  }

  throw new Error(`unknown command: ${cmd} (try --help)`)
}

main(process.argv.slice(2)).catch((e) => {
  console.error(String(e?.shortMessage ?? e?.message ?? e))
  process.exit(1)
})
