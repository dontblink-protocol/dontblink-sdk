// 只读：新发射列表、费用、风险标签。给 agent 技能和 CLI 用。
//
// 三条规矩，改之前先想清楚：
// - **只给事实，不排序、不推荐。** 列表永远按时间倒序；风险标签只写链上能核的事实，
//   不打分、不说"值得买"。
// - **不做"即将毕业"查询。** 内盘进度这种字段只会把人往抢跑上引，这里一个都不读。
// - **限频。** 默认每次 RPC 之间隔 200ms、一次最多 50 条；公共 RPC 是大家的。

import { erc20Abi, parseAbiItem, zeroAddress, type Address, type PublicClient } from 'viem'
import { PORTAL, portalAbi, Mode } from './core.js'

/** Portal 第一笔发射之前的块（2026-08-17 之前），往前不用再扫。 */
export const PORTAL_FROM_BLOCK = 29_000_000n
/** 公共 RPC 单次 getLogs 能接受的跨度（实测 1000 万块可以，3000 万块被拒）。 */
export const LOG_SPAN = 10_000_000n
export const MAX_LIMIT = 50

const launchedEvent = parseAbiItem(
  'event Launched(uint256 indexed nonce, address indexed token, address indexed creator, uint16 version, uint8 mode, address quote, address pool, uint256 tokenId, uint256 saleId, uint64 windowEnd)',
)
const rulesEvent = parseAbiItem(
  'event LaunchRules(address indexed token, uint24 poolFee, uint128 hardCap, uint16 capBps, uint16 burnBps, uint16 tradeFeeBps, bool requireTicket, uint256 circulatingSupply, int24 startTick, uint8 allocMode, uint32 windowDuration)',
)
const metaEvent = parseAbiItem(
  'event LaunchMetadata(address indexed token, string imageURI, string xUrl, string webUrl, string tgUrl, string bio)',
)

export type Fees = {
  /** 固定发行费，wei（原生 ETH）。 */
  launchFee: bigint
  /** 一级成交抽成，100 = 1%。 */
  tradeFeeBps: number
  /** 协议费里分给推荐人（接入方）的比例，3000 = 30%。 */
  referrerShareBps: number
  /** 毕业后 LP 手续费给发行方的比例，5000 = 50%。 */
  creatorLpBps: number
}

export type LaunchInfo = {
  token: Address
  name: string | null
  symbol: string | null
  creator: Address
  /** 链上 Mode 枚举只到 3（Handler）；更大的值是以后追加的玩法，这里不认识就标 unknown。 */
  mode: 'instant' | 'queue' | 'curve' | 'handler' | 'unknown'
  /** null = 原生 ETH 计价。 */
  quote: Address | null
  quoteSymbol: string | null
  block: bigint
  /** 发射时间，UTC 秒。 */
  time: number
  windowEnd: number
  /** 找不到 LaunchRules 事件时两项都是 null：不猜。 */
  fees: { poolFeeBps: number | null; tradeFeeBps: number | null }
  rules: { capBps: number | null; burnBps: number | null; requireTicket: boolean | null }
  socials: { x: boolean; web: boolean; tg: boolean } | null
  riskTags: string[]
}

export type ReadOptions = {
  /** 最多几条，默认 20，上限 50。 */
  limit?: number
  /** 只看最近多少块；不填就从 Portal 部署前一路扫到现在。 */
  lookbackBlocks?: bigint
  /** 两次 RPC 之间至少隔多久，毫秒，默认 200。 */
  minIntervalMs?: number
}

const MODES = ['instant', 'queue', 'curve', 'handler'] as const

function throttle(ms: number) {
  let last = 0
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const wait = last + ms - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    last = Date.now()
    return fn()
  }
}

export async function getFees(client: PublicClient): Promise<Fees> {
  const [launchFee, tradeFeeBps, referrerShareBps, creatorLpBps] = (await client.readContract({
    address: PORTAL,
    abi: portalAbi,
    functionName: 'fees',
  })) as readonly [bigint, number, number, number]
  return { launchFee, tradeFeeBps, referrerShareBps, creatorLpBps }
}

/**
 * 最近的发射，按时间倒序。只读，不签名，不排序。
 *
 * 风险标签只写事实（计价资产、模式、有没有销毁、配额靠什么执行、同一个发行方在这批里发了几个、
 * 有没有填社交链接）。**没有**内盘进度、没有排名。
 */
export async function listLaunches(client: PublicClient, opts: ReadOptions = {}): Promise<LaunchInfo[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), MAX_LIMIT)
  const call = throttle(opts.minIntervalMs ?? 200)
  const head = await call(() => client.getBlockNumber())
  if (opts.lookbackBlocks !== undefined && opts.lookbackBlocks <= 0n) throw new Error('lookbackBlocks must be positive')
  const floor = opts.lookbackBlocks ? (head > opts.lookbackBlocks ? head - opts.lookbackBlocks : 0n) : PORTAL_FROM_BLOCK

  // 从新往旧一段段扫，够 limit 条就停。
  const launched: Awaited<ReturnType<typeof getLaunched>> = []
  async function getLaunched(from: bigint, to: bigint) {
    return call(() => client.getLogs({ address: PORTAL, event: launchedEvent, fromBlock: from, toBlock: to }))
  }
  let to = head
  let from = head
  while (to >= floor && launched.length < limit) {
    from = to - LOG_SPAN + 1n > floor ? to - LOG_SPAN + 1n : floor
    launched.unshift(...(await getLaunched(from, to)))
    if (from === floor) break
    to = from - 1n
  }
  const picked = launched.slice(-limit).reverse()
  if (!picked.length) return []

  // 规则和社交链接在同一笔交易里另发的事件，按 token 对上。跨度可能超过 LOG_SPAN，分段查。
  // 不按 token 过滤：公共 RPC 对多个 token 的 OR 过滤只给 10 万块跨度，不如全拿回来本地对。
  const lo = picked[picked.length - 1].blockNumber
  const hi = picked[0].blockNumber
  const rules: Awaited<ReturnType<typeof getRules>> = []
  const metas: Awaited<ReturnType<typeof getMetas>> = []
  async function getRules(from: bigint, to: bigint) {
    return call(() => client.getLogs({ address: PORTAL, event: rulesEvent, fromBlock: from, toBlock: to }))
  }
  async function getMetas(from: bigint, to: bigint) {
    return call(() => client.getLogs({ address: PORTAL, event: metaEvent, fromBlock: from, toBlock: to }))
  }
  for (let s = lo; s <= hi; s += LOG_SPAN) {
    const e = s + LOG_SPAN - 1n < hi ? s + LOG_SPAN - 1n : hi
    rules.push(...(await getRules(s, e)))
    metas.push(...(await getMetas(s, e)))
  }
  const ruleOf = new Map(rules.map((r) => [(r.args.token as Address).toLowerCase(), r.args]))
  const metaOf = new Map(metas.map((m) => [(m.args.token as Address).toLowerCase(), m.args]))

  const byCreator = new Map<string, number>()
  for (const l of picked) {
    const c = (l.args.creator as Address).toLowerCase()
    byCreator.set(c, (byCreator.get(c) ?? 0) + 1)
  }

  const now = Math.floor(Date.now() / 1000)
  const out: LaunchInfo[] = []
  const blockTime = new Map<bigint, number>()
  const symbolCache = new Map<string, string | null>()
  const readStr = async (address: Address, functionName: 'name' | 'symbol') => {
    try {
      return (await call(() => client.readContract({ address, abi: erc20Abi, functionName }))) as string
    } catch {
      return null
    }
  }

  for (const l of picked) {
    const a = l.args
    const token = a.token as Address
    if (!blockTime.has(l.blockNumber)) {
      const b = await call(() => client.getBlock({ blockNumber: l.blockNumber }))
      blockTime.set(l.blockNumber, Number(b.timestamp))
    }
    const quote = (a.quote as Address) === zeroAddress ? null : (a.quote as Address)
    let quoteSymbol: string | null = 'ETH'
    if (quote) {
      const k = quote.toLowerCase()
      if (!symbolCache.has(k)) symbolCache.set(k, await readStr(quote, 'symbol'))
      quoteSymbol = symbolCache.get(k) ?? null
    }
    const r = ruleOf.get(token.toLowerCase())
    const m = metaOf.get(token.toLowerCase())
    const mode = MODES[Number(a.mode)] ?? 'unknown'
    const info: LaunchInfo = {
      token,
      name: await readStr(token, 'name'),
      symbol: await readStr(token, 'symbol'),
      creator: a.creator as Address,
      mode,
      quote,
      quoteSymbol,
      block: l.blockNumber,
      time: blockTime.get(l.blockNumber)!,
      windowEnd: Number(a.windowEnd),
      fees: { poolFeeBps: r ? Number(r.poolFee) / 100 : null, tradeFeeBps: r ? Number(r.tradeFeeBps) : null },
      rules: {
        capBps: r ? Number(r.capBps) : null,
        burnBps: r ? Number(r.burnBps) : null,
        requireTicket: r ? Boolean(r.requireTicket) : null,
      },
      socials: m ? { x: !!m.xUrl, web: !!m.webUrl, tg: !!m.tgUrl } : null,
      riskTags: [],
    }
    info.riskTags = riskTags(info, { now, sameCreatorInList: byCreator.get(info.creator.toLowerCase()) ?? 1 })
    out.push(info)
  }
  return out
}

/** 风险标签：只写链上能核的事实。顺序固定，不代表轻重。 */
export function riskTags(l: LaunchInfo, ctx: { now: number; sameCreatorInList: number }): string[] {
  const t: string[] = []
  if (l.quote) t.push(`quote:${l.quoteSymbol ?? 'unknown'}`)
  // 出处：dontblink-mech@5e6516e src/v2/CurveSale.sol:75（MAX_TOTAL_BPS = 500）、:176-177（买卖各自 fee + tax 超过就 revert）
  if (l.mode === 'curve') t.push('curve:creator-tax-possible(fee+tax<=5%)')
  if (l.mode === 'handler') t.push('handler:custom-rules')
  if (l.mode === 'unknown') t.push('mode:unknown')
  if (l.mode === 'queue' && l.windowEnd > ctx.now) t.push('queue:window-open')
  // 出处：dontblink-mech@5e6516e src/v2/SoftQuotaRouter.sol:18-19（不要票按 tx.origin 累计，多钱包可绕；要票按票里的 accountId）
  if (l.mode === 'instant' && l.rules.requireTicket === false) t.push('quota:per-tx-origin-only')
  if (l.rules.burnBps) t.push(`burn:${l.rules.burnBps / 100}%`)
  if (l.rules.capBps === null) t.push('rules:not-found')
  if (ctx.sameCreatorInList > 1) t.push(`creator:${ctx.sameCreatorInList}-launches-in-list`)
  // 走 handler 的发射不一定发 LaunchMetadata，找不到不等于没填。
  if (!l.socials) t.push('socials:not-found')
  else if (!l.socials.x && !l.socials.web && !l.socials.tg) t.push('socials:none')
  return t
}
