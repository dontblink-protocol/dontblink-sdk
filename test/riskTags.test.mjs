// riskTags 是纯函数：只看传进来的发射信息，不碰链。跑之前要先 build（npm test 会自己 build）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskTags } from '../dist/read.js'

const NOW = 1_800_000_000
const base = {
  token: '0x0000000000000000000000000000000000000001',
  name: 'T',
  symbol: 'T',
  creator: '0x0000000000000000000000000000000000000002',
  mode: 'instant',
  quote: null,
  quoteSymbol: 'ETH',
  block: 1n,
  time: NOW - 60,
  windowEnd: 0,
  fees: { poolFeeBps: 100, tradeFeeBps: 100 },
  rules: { capBps: 500, burnBps: 0, requireTicket: true },
  socials: { x: true, web: false, tg: false },
  riskTags: [],
}
const tags = (over, ctx = {}) => riskTags({ ...base, ...over }, { now: NOW, sameCreatorInList: 1, ...ctx })

test('a plain ETH instant launch with a ticket and socials has no tags', () => {
  assert.deepEqual(tags({}), [])
})

test('non-ETH quote, curve tax and burn are reported as facts', () => {
  assert.deepEqual(tags({ quote: '0x0000000000000000000000000000000000000003', quoteSymbol: 'NVDA' }), ['quote:NVDA'])
  assert.deepEqual(tags({ mode: 'curve' }), ['curve:creator-tax-possible(fee+tax<=5%)'])
  assert.deepEqual(tags({ rules: { capBps: 500, burnBps: 250, requireTicket: true } }), ['burn:2.5%'])
})

test('instant without a ticket is flagged as per-tx-origin quota; queue only while the window is open', () => {
  assert.deepEqual(tags({ rules: { capBps: 500, burnBps: 0, requireTicket: false } }), ['quota:per-tx-origin-only'])
  assert.deepEqual(tags({ mode: 'queue', windowEnd: NOW + 60 }), ['queue:window-open'])
  assert.deepEqual(tags({ mode: 'queue', windowEnd: NOW - 60 }), [])
})

test('unknown modes are not dressed up as handler launches', () => {
  assert.deepEqual(tags({ mode: 'handler' }), ['handler:custom-rules'])
  assert.deepEqual(tags({ mode: 'unknown' }), ['mode:unknown'])
})

test('missing rules or metadata are said out loud, not filled in', () => {
  const t = tags({ fees: { poolFeeBps: null, tradeFeeBps: null }, rules: { capBps: null, burnBps: null, requireTicket: null }, socials: null })
  assert.deepEqual(t, ['rules:not-found', 'socials:not-found'])
  assert.deepEqual(tags({ socials: { x: false, web: false, tg: false } }), ['socials:none'])
})

test('repeat creators within the list are counted', () => {
  assert.deepEqual(tags({}, { sameCreatorInList: 3 }), ['creator:3-launches-in-list'])
})
