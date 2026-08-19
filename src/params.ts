// 各模式的参数构造器。
//
// **这是 SDK 存在的主要理由。** `launch` 吃 21 个字段，其中几个是「填错了链上不会
// revert、只会静默出错」的类型 —— 自己拼很容易中招。这里每个模式给一个构造器，
// 把没人会去想的字段填成经过测试的值，调用方只覆盖自己真正要改的。

import { Mode, POOL_FEE, START_TICK_MAGNITUDE, ZERO, type LaunchParams } from './core.js'
import type { Address } from 'viem'

/** 每个模式都要的那几样。 */
export type BaseInput = {
  name: string
  symbol: string
  /** 图片 URL 或 data URI。留空则前端显示地址后四位。 */
  imageURI?: string
  bio?: string
  xUrl?: string
  webUrl?: string
  tgUrl?: string
  /** 发行费的一部分链上即时付给他。零地址 = 没有推荐人。 */
  referrer?: Address
}

function base(i: BaseInput): Pick<LaunchParams, 'name' | 'symbol' | 'imageURI' | 'bio' | 'xUrl' | 'webUrl' | 'tgUrl' | 'referrer'> {
  return {
    name: i.name,
    symbol: i.symbol,
    imageURI: i.imageURI ?? '',
    bio: i.bio ?? '',
    xUrl: i.xUrl ?? '',
    webUrl: i.webUrl ?? '',
    tgUrl: i.tgUrl ?? '',
    referrer: i.referrer ?? ZERO,
  }
}

/**
 * Classic / 即时建池。全部供应单边铺进 Uniswap V3 池，发行方 0 持仓、0 成本。
 * LP 仓位直接铸进 LpLock —— 本金在字节码层面撤不出来。
 */
export function instantParams(i: BaseInput & Partial<LaunchParams>): LaunchParams {
  return {
    version: 1,
    quote: ZERO,
    poolFee: POOL_FEE,
    startTickMagnitude: START_TICK_MAGNITUDE,
    windowDuration: 0,
    mode: Mode.Instant,
    hardCap: 0n,
    capBps: 0,
    allocMode: 0,
    burnBps: 0,
    requireTicket: false,
    buyTaxBps: 0,
    sellTaxBps: 0,
    ...base(i),
    ...i,
  }
}

/**
 * 内盘曲线。先在曲线合约里买卖，募够阈值时**在那笔买单内部**毕业建池。
 *
 * 税只在内盘里成立 —— V3 池上结构性收不到（已实证）。其余模式必须填 0，
 * 合约会明确 revert 而不是静默忽略。
 */
export function curveParams(i: BaseInput & Partial<LaunchParams>): LaunchParams {
  return {
    ...instantParams(i),
    mode: Mode.Curve,
    ...i,
  }
}

/**
 * Fair Queue。窗口内只排队，关闭后统一清算价成交 —— 窗口里不存在「谁先谁便宜」。
 *
 * `windowDuration` / `hardCap` / `capBps` 填 0 = 用链上当下的默认值；
 * 填了就必须落在治理设定的区间内，否则 revert。
 */
export function queueParams(
  i: BaseInput & Partial<LaunchParams> & { windowDuration?: number; hardCap?: bigint; capBps?: number },
): LaunchParams {
  return {
    ...instantParams(i),
    mode: Mode.Queue,
    ...i,
  }
}

/**
 * 用一个代币化股票计价（NVDA / TSLA …）。
 *
 * **`startTickMagnitude` 必须按该股票算，不能照抄 ETH 的值。**
 * 开盘区间取自「该股票 / ETH 池子」的 tick；照搬 ETH 的区间会让开盘价差十倍上下，
 * 而且**链上不会 revert，只会静默错价**。用 `stockMagnitude()` 算（见 stock.ts），
 * 别自己填。
 */
export function stockQuotedParams(
  i: BaseInput & Partial<LaunchParams> & { quote: Address; startTickMagnitude: number },
): LaunchParams {
  if (!i.quote || i.quote === ZERO) {
    throw new Error('stockQuotedParams needs a real quote asset — pass the stock token address')
  }
  if (!i.startTickMagnitude) {
    throw new Error(
      'stockQuotedParams needs startTickMagnitude computed for THIS quote asset — use stockMagnitude(). ' +
        'Copying the ETH value opens the pool at the wrong price and the chain will not stop you.',
    )
  }
  return {
    ...instantParams(i),
    mode: Mode.Instant,
    ...i,
  }
}
