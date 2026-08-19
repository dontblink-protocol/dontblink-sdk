// 链上常量与地址推导。
//
// 这些值从前端 `ssi-launchpad-rh/web/src/lib/portal.ts` 抽出来，那一版的地址推导
// **已对着主网 `predictToken` 逐盐核过三组**。本文件的 `predictToken()` 与它逐字节一致，
// 并且 `mineVanitySalt()` 在返回之前可以（也建议）用 `verifyOnChain` 再问一次链。

import {
  keccak256,
  concatHex,
  encodeAbiParameters,
  getAddress,
  toHex,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem'

/** Robinhood Chain 主网。 */
export const CHAIN_ID = 4663
export const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com'

/** v2 Portal 代理 —— 地址永不变，实现可升级。 */
export const PORTAL: Address = '0x7a4EB7F99833178c6463184bd0D8d17b6FC2d59c'
/** version 1 的代币实现（所有 EIP-1167 克隆都指向它）。 */
export const TOKEN_IMPL_V1: Address = '0xbdB3695972c977488F3B45607FF35432B5497702'
export const WETH: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

/** 发行池的费率档。全站的币都开在 1% 档，和 v1 一致。 */
export const POOL_FEE = 10_000
/** ETH 计价发行的起始 tick 幅度。必须是 tickSpacing(200) 的整数倍。 */
export const START_TICK_MAGNITUDE = 198_000

export const portalAbi = parseAbi([
  'function launch((uint16 version,string name,string symbol,address quote,uint24 poolFee,uint24 startTickMagnitude,uint32 windowDuration,uint8 mode,uint128 hardCap,uint16 capBps,uint8 allocMode,uint16 burnBps,bool requireTicket,address referrer,string imageURI,string xUrl,string webUrl,string tgUrl,string bio,uint16 buyTaxBps,uint16 sellTaxBps) p, bytes32 salt) payable returns (address token, address pool)',
  'function predictToken(uint16 version, address creator, bytes32 salt) view returns (address)',
  'function fees() view returns (uint96 launchFee, uint16 tradeFeeBps, uint16 referrerShareBps, uint16 creatorLpBps)',
  'function launches(address) view returns (address creator, address quote, address pool, uint256 tokenId, uint256 saleId, uint24 poolFee, uint16 version, uint8 mode, uint64 windowEnd, uint16 creatorLpBps, bool exists)',
])

/** 发行模式。**只可追加** —— 这些值是上链数据，中间插一个会改写已发行代币的模式。 */
export enum Mode {
  Instant = 0,
  Queue = 1,
  Curve = 2,
}

export type LaunchParams = {
  version: number
  name: string
  symbol: string
  /** 零地址 = 原生 ETH（底下是 WETH 池）。填代币地址 = 用它计价。 */
  quote: Address
  poolFee: number
  startTickMagnitude: number
  windowDuration: number
  mode: Mode
  hardCap: bigint
  capBps: number
  allocMode: number
  burnBps: number
  requireTicket: boolean
  referrer: Address
  imageURI: string
  xUrl: string
  webUrl: string
  tgUrl: string
  bio: string
  buyTaxBps: number
  sellTaxBps: number
}

export const ZERO: Address = '0x0000000000000000000000000000000000000000'

// ---------------------------------------------------------------- 地址推导

// EIP-1167 minimal proxy 的 initcode 前后缀 —— 克隆地址由它和 salt 决定。
const CLONE_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' as Hex
const CLONE_SUFFIX = '0x5af43d82803e903d91602b57fd5bf3' as Hex

const initCodeHashCache = new Map<string, Hash>()
function cloneInitCodeHash(impl: Address): Hash {
  let h = initCodeHashCache.get(impl)
  if (!h) {
    h = keccak256(concatHex([CLONE_PREFIX, impl, CLONE_SUFFIX]))
    initCodeHashCache.set(impl, h)
  }
  return h
}

/**
 * 合约把 creator 混进盐里。
 *
 * **这不是多余的一步**：没有它，别人看到你待打包的交易就能用同一个 salt 抢先把
 * 那个地址占掉。混进 creator 之后，同一个 salt 对不同的钱包算出不同的地址。
 *
 * 直接后果：**换个钱包发币，你挖到的 salt 就失效了。**
 */
export function effectiveSalt(creator: Address, userSalt: Hash): Hash {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, userSalt]))
}

/** 与链上 `predictToken(1, creator, salt)` 等价的本地推导（不走 RPC）。 */
export function predictToken(creator: Address, userSalt: Hash, impl: Address = TOKEN_IMPL_V1): Address {
  const salt = effectiveSalt(creator, userSalt)
  return getAddress('0x' + keccak256(concatHex(['0xff', PORTAL, salt, cloneInitCodeHash(impl)])).slice(26))
}

export function randomSalt(): Hash {
  const b = new Uint8Array(32)
  // Node 18+ 和所有现代浏览器都有 globalThis.crypto，不需要 require —— 这个包是纯 ESM。
  const c = globalThis.crypto
  if (!c?.getRandomValues) {
    throw new Error('no Web Crypto available — need Node 18+ or a modern browser')
  }
  c.getRandomValues(b)
  return toHex(b) as Hash
}

// ---------------------------------------------------------------- 靓号

/** 站上所有走发行页的币都是这个后缀。4 位 ≈ 6.5 万次期望，本地几百毫秒。 */
export const VANITY_SUFFIX = 'dbdb'

export type MinedSalt = { salt: Hash; address: Address; vanity: boolean; tries: number }

/**
 * 挖一个让代币地址以 `suffix` 结尾的盐。
 *
 * **靓号不是合约给的，是挖出来的** —— 直接调 `launch` 传随机盐，拿到的就是随机地址。
 * 这也是为什么直接调合约的人发出来的币没有 `…dbdb` 结尾。
 *
 * 后缀每多一位，期望次数乘 16：4 位约 6.5 万次（毫秒级），6 位约 1670 万次（分钟级）。
 * `budgetMs` 用完还没命中就**退回随机盐并标 `vanity: false`** —— 靓号是锦上添花，
 * 不该变成发不出币的理由。
 */
export function mineVanitySalt(
  creator: Address,
  opts: { suffix?: string; budgetMs?: number; impl?: Address; onProgress?: (tries: number) => void } = {},
): MinedSalt {
  const suffix = (opts.suffix ?? VANITY_SUFFIX).toLowerCase()
  if (!/^[0-9a-f]{1,8}$/.test(suffix)) throw new Error(`suffix "${suffix}" is not valid hex`)
  const budgetMs = opts.budgetMs ?? 15_000
  const t0 = Date.now()
  let tries = 0
  for (;;) {
    const salt = randomSalt()
    const address = predictToken(creator, salt, opts.impl)
    tries++
    if (address.toLowerCase().endsWith(suffix)) return { salt, address, vanity: true, tries }
    if (tries % 50_000 === 0) {
      opts.onProgress?.(tries)
      if (Date.now() - t0 > budgetMs) {
        const salt2 = randomSalt()
        return { salt: salt2, address: predictToken(creator, salt2, opts.impl), vanity: false, tries }
      }
    }
  }
}

/**
 * 拿本地算的地址去链上再问一遍。
 *
 * **建议在真发之前调一次。** 本地推导和合约哪怕差一个字节，发出去就是另一个地址，
 * 而那时候钱已经花了。这个函数存在的意义就是把那种错误拦在花钱之前。
 */
export async function verifyOnChain(
  client: PublicClient,
  creator: Address,
  salt: Hash,
  expected: Address,
): Promise<void> {
  const onchain = (await client.readContract({
    address: PORTAL,
    abi: portalAbi,
    functionName: 'predictToken',
    args: [1, creator, salt],
  })) as Address
  if (getAddress(onchain) !== getAddress(expected)) {
    throw new Error(
      `predictToken mismatch: chain says ${onchain}, local computed ${expected}. ` +
        `Do not launch with this salt — the local derivation is out of sync with the contract.`,
    )
  }
}
