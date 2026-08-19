// 用代币化股票计价时，那个必须算对的 `startTickMagnitude`。
//
// **这是整个 SDK 里最容易出错、且出错不会报错的地方。**
//
// v2 Portal 铺的是**单边**流动性：`tickLower = startTick`、另一端到底。它只吃一个
// magnitude（无符号），**符号由合约按地址排序自己定**（`token < quote ? -mag : +mag`）。
//
// 开盘价是相对报价资产的。把 ETH 计价用的 198000 照抄到 NVDA 计价的发行上，
// 开出来的池子价格差十倍上下 —— 而 `launch` **不会 revert**，池子照建、币照发，
// 只是价格是错的。这一条在主网 fork 上有实证与反例：
// `dontblink-mech/test/StockQuoteMagnitude.t.sol` 3/3，其中 test_03 就是照抄的反例。

import { getAddress, parseAbi, type Address, type PublicClient } from 'viem'
import { START_TICK_MAGNITUDE, WETH } from './core.js'

/** Robinhood Chain 上的 Uniswap V3 工厂。 */
export const V3_FACTORY: Address = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA'

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)',
])
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)'])

/**
 * 报价资产的池子太浅就不该用它计价 —— 开盘价取自那个池子的 tick，
 * 池子浅到几百美元就能推动，等于把开盘价交给任何一个愿意花点小钱的人。
 */
export const MIN_QUOTE_POOL_WETH = 10n ** 18n // 1 WETH

export type QuoteInfo = {
  /** 该资产 / WETH 的池子。 */
  pool: Address
  /** 池子里的 WETH 数量 —— 越深越不容易被推动。 */
  wethDepth: bigint
  /** 「1 单位报价资产值多少 WETH」的 tick，已按符号归一。 */
  shiftTicks: number
  /** 按发行池 spacing 对齐之后的值。 */
  shiftAligned: number
}

function spacingOf(fee: number): number {
  if (fee === 100) return 1
  if (fee === 500) return 10
  if (fee === 3000) return 60
  if (fee === 10_000) return 200
  throw new Error(`unknown fee tier ${fee}`)
}

/**
 * 读这个报价资产相对 ETH 的位置。
 *
 * 刻意从**池子的 tick** 取，而不是从任何美元喂价 —— tick 本身就是原始单位比，
 * 非 18 位小数的资产也不用额外换算。这条链上目前没有已发布的股票喂价
 * （2026-08-19 核实：同链竞品的合约里 oracle 相关代码出现 0 次，其 UI 也写着
 * "Chainlink feed pending"），所以**池子就是价格**。
 */
export async function readQuote(
  client: PublicClient,
  quote: Address,
  opts: { tiers?: number[] } = {},
): Promise<QuoteInfo> {
  const q = getAddress(quote)
  if (q === getAddress(WETH)) throw new Error('WETH is the base — no shift needed')

  // 按**真实深度**挑池子，不按费率档的惯例。同一对可能在多个档上都有池子，
  // 而其中一些薄到只有几 wei。
  const tiers = opts.tiers ?? [500, 3000, 10_000]
  let best: { pool: Address; depth: bigint } | null = null
  for (const fee of tiers) {
    const pool = (await client.readContract({
      address: V3_FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [q, WETH, fee],
    })) as Address
    if (pool === '0x0000000000000000000000000000000000000000') continue
    const depth = (await client.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [pool],
    })) as bigint
    if (!best || depth > best.depth) best = { pool, depth }
  }
  if (!best) throw new Error(`no ${q}/WETH pool on this chain — cannot price a launch against it`)
  if (best.depth < MIN_QUOTE_POOL_WETH) {
    throw new Error(
      `quote pool too thin (${best.depth} wei WETH) — a launch priced off it can be moved by anyone. ` +
        `Pick a quote asset with a deeper pool.`,
    )
  }

  const [, tick] = (await client.readContract({
    address: best.pool,
    abi: poolAbi,
    functionName: 'slot0',
  })) as [bigint, number, number, number, number, number, boolean]
  const token0 = (await client.readContract({
    address: best.pool,
    abi: poolAbi,
    functionName: 'token0',
  })) as Address

  // 池子的 tick 是 token1/token0。我们要的是「WETH per quote」，
  // 所以 token0 是 WETH 的时候取反。
  const shiftTicks = getAddress(token0) === getAddress(WETH) ? -tick : tick
  return { pool: best.pool, wethDepth: best.depth, shiftTicks, shiftAligned: shiftTicks }
}

/**
 * 算出用这个报价资产发行时该传的 `startTickMagnitude`。
 *
 * 公式 = ETH 计价的基础值 + 该资产相对 WETH 的 tick 偏移，按发行池 spacing 对齐。
 * **就近取整**（`Math.round`）—— 与网站前端一致，两边算出来的是同一个数。
 *
 * 已在主网 fork 上实证：换算回 WETH 之后与 ETH 计价开在同一个真实价位，
 * 误差不超过一个 spacing。
 */
export async function stockMagnitude(
  client: PublicClient,
  quote: Address,
  opts: { poolFee?: number; baseMagnitude?: number } = {},
): Promise<{ magnitude: number; info: QuoteInfo }> {
  const fee = opts.poolFee ?? 10_000
  const spacing = spacingOf(fee)
  const info = await readQuote(client, quote)
  const aligned = Math.round(info.shiftTicks / spacing) * spacing
  const magnitude = (opts.baseMagnitude ?? START_TICK_MAGNITUDE) + aligned

  if (magnitude % spacing !== 0) {
    throw new Error(`magnitude ${magnitude} is not a multiple of spacing ${spacing}`)
  }
  // 合约把它当 uint24，且 mag == 0 直接 revert BadParams。
  if (magnitude <= 0 || magnitude >= 887_272) {
    throw new Error(
      `magnitude ${magnitude} out of range — this quote asset sits too far from ETH to price a launch against`,
    )
  }
  return { magnitude, info: { ...info, shiftAligned: aligned } }
}
