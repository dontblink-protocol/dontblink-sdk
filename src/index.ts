// @dontblink/sdk —— 从代码里发币。
//
// **你自己签名，我们不碰你的钥匙。** 这个包做的是把交易构造对：正确的模式参数、
// 挖靓号盐、股票计价那个算错也不报错的 tick。签名和广播用你自己的 viem WalletClient。
//
// 这不是「一个 HTTP 请求发币」那种托管式 API。我们整套东西的卖点是可验证、
// 不用信任我们（LP 锁死在字节码里、账本无许可、攻击复盘公开）——
// 替用户签名会突然多出一个「你得信我们不乱来」的环节。

import { getAddress, type Address, type Hash, type PublicClient, type WalletClient } from 'viem'
import { PORTAL, portalAbi, predictToken, mineVanitySalt, verifyOnChain, VANITY_SUFFIX, type LaunchParams } from './core.js'

export * from './core.js'
export * from './params.js'
export * from './stock.js'
export * from './read.js'

export type LaunchResult = {
  /** 新币地址。 */
  token: Address
  /** Uniswap V3 池子。内盘（Curve）模式毕业前是零地址。 */
  pool: Address
  txHash: Hash
  /** 用的盐 —— 存下来，出问题时能复现这次发行。 */
  salt: Hash
  /** 有没有拿到靓号后缀。挖不到会退回随机盐，这里就是 false。 */
  vanity: boolean
}

export type LaunchOptions = {
  /** 自己指定盐则不挖。 */
  salt?: Hash
  /** 靓号后缀，默认 `dbdb`。每多一位期望次数乘 16。 */
  vanitySuffix?: string
  /** 挖盐预算，默认 15s。用完退回随机盐，**不会**因此发不出币。 */
  vanityBudgetMs?: number
  /**
   * 发之前拿本地算的地址去链上 `predictToken` 再问一次，默认 **true**。
   * 关掉它省一次 RPC 往返，但也就失去了「本地推导和合约不一致」这条防线 ——
   * 那种错误的表现是币发到了另一个地址上，而钱已经花了。
   */
  verify?: boolean
  onProgress?: (msg: string) => void
}

/**
 * 发一枚币。
 *
 * ```ts
 * import { createPublicClient, createWalletClient, http } from 'viem'
 * import { privateKeyToAccount } from 'viem/accounts'
 * import { launch, instantParams } from '@dontblink/sdk'
 *
 * const account = privateKeyToAccount(process.env.PK as `0x${string}`)
 * const publicClient = createPublicClient({ transport: http(RPC) })
 * const walletClient = createWalletClient({ account, transport: http(RPC) })
 *
 * const { token, pool } = await launch({
 *   publicClient, walletClient,
 *   params: instantParams({ name: 'My Token', symbol: 'MTK' }),
 * })
 * ```
 */
export async function launch(args: {
  publicClient: PublicClient
  walletClient: WalletClient
  params: LaunchParams
  options?: LaunchOptions
}): Promise<LaunchResult> {
  const { publicClient, walletClient, params } = args
  const o = args.options ?? {}
  const say = o.onProgress ?? (() => {})

  const account = walletClient.account
  if (!account) throw new Error('walletClient has no account — pass one when you create it')
  const creator = getAddress(account.address)

  // 1) 盐
  let salt = o.salt
  let vanity = false
  let predicted: Address
  if (salt) {
    predicted = predictToken(creator, salt)
  } else {
    say(`Mining a …${o.vanitySuffix ?? VANITY_SUFFIX} address`)
    const mined = mineVanitySalt(creator, {
      suffix: o.vanitySuffix,
      budgetMs: o.vanityBudgetMs,
      onProgress: (n) => say(`  ${(n / 1000).toFixed(0)}k tries…`),
    })
    salt = mined.salt
    predicted = mined.address
    vanity = mined.vanity
    if (!vanity) say('  budget spent — falling back to a random salt (launch still works)')
  }

  // 2) 自证：本地推导和合约必须一致，否则币会发到别的地址上
  if (o.verify !== false) {
    say('Verifying the predicted address against the contract')
    await verifyOnChain(publicClient, creator, salt, predicted)
  }

  // 3) 发行费 —— **只发这一笔，一分不多**。
  //    多付的部分合约会原路退回（不会变成首买），所以别指望用 value 做首买。
  const fees = (await publicClient.readContract({
    address: PORTAL,
    abi: portalAbi,
    functionName: 'fees',
  })) as readonly [bigint, number, number, number]
  const value = fees[0]

  // 4) 先模拟。参数错了要在这里炸，而不是花完 gas 才发现。
  say('Simulating')
  const { request, result } = await publicClient.simulateContract({
    address: PORTAL,
    abi: portalAbi,
    functionName: 'launch',
    args: [params, salt],
    account: creator,
    value,
  })
  const [token, pool] = result as unknown as [Address, Address]

  // 5) 签名 + 广播 —— 用**你的**钱包
  say('Signing')
  const txHash = await walletClient.writeContract({ ...request, account })
  say('Waiting for confirmation')
  await publicClient.waitForTransactionReceipt({ hash: txHash })

  return { token: getAddress(token), pool: getAddress(pool), txHash, salt, vanity }
}
