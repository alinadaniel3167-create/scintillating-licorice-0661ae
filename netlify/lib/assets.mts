/* ==========================================================================
   The six payment options, server-side.

   The checkout markup still carries data-* attributes for the picker labels,
   but the money-critical fields — address, coin, decimals — are authoritative
   here. /api/order returns the address and amount it decided on, and the page
   renders that rather than its own arithmetic, so the two cannot drift.

   `coin` and `tickerSymbol` are MEXC's names. `network` is the label the
   customer sees; MEXC reports its own network strings on a deposit and those
   are recorded but deliberately not used to reject a payment — see the note
   in mexc-poll.mts about the shared EVM address.
   ========================================================================== */

export interface PayAsset {
  id: string
  name: string
  sym: string
  coin: string
  network: string
  address: string
  /* Decimals the customer is asked to send, and therefore the precision the
     jitter has to live in. */
  dec: number
  /* USDT pairs quote at 1:1 and have no ticker to look up. */
  tickerSymbol: string | null
  conf: string
  eta: string
  /* MEXC's minimum credited deposit. A transfer below it is swallowed rather
     than credited, so it would never reach deposit history and could never be
     matched. Every plan here is in the hundreds of dollars, so the only thing
     that can breach one of these floors is a badly wrong exchange rate —
     which is what /api/order checks it for before quoting an amount. */
  minDeposit: number
}

const ASSETS: PayAsset[] = [
  {
    id: 'btc',
    name: 'Bitcoin',
    sym: 'BTC',
    coin: 'BTC',
    network: 'Bitcoin network',
    address: '39vZ12QQAxQrAvKz8UUro5dHsFBH7cH59e',
    dec: 8,
    tickerSymbol: 'BTCUSDT',
    conf: '2 confirmations',
    eta: '~20 min',
    minDeposit: 0.000006
  },
  {
    id: 'eth',
    name: 'Ethereum',
    sym: 'ETH',
    coin: 'ETH',
    network: 'Ethereum mainnet',
    address: '0x748159801ef8083ad6b679fe3c973ba9d26d0e0f',
    dec: 6,
    tickerSymbol: 'ETHUSDT',
    conf: '12 confirmations',
    eta: '~3 min',
    minDeposit: 0.01
  },
  {
    id: 'usdt-trc20',
    name: 'Tether USDT',
    sym: 'USDT',
    coin: 'USDT',
    network: 'Tron (TRC-20)',
    address: 'TJgVMgfMMgsfU2M1FqezUTufW7QBqaTCYS',
    dec: 2,
    tickerSymbol: null,
    conf: '19 confirmations',
    eta: '~1 min',
    minDeposit: 1
  },
  {
    id: 'usdt-erc20',
    name: 'Tether USDT',
    sym: 'USDT',
    coin: 'USDT',
    network: 'Ethereum (ERC-20)',
    address: '0x748159801ef8083ad6b679fe3c973ba9d26d0e0f',
    dec: 2,
    tickerSymbol: null,
    conf: '12 confirmations',
    eta: '~3 min',
    minDeposit: 1
  },
  {
    id: 'usdt-bep20',
    name: 'Tether USDT',
    sym: 'USDT',
    coin: 'USDT',
    network: 'BNB Smart Chain (BEP-20)',
    address: '0x748159801ef8083ad6b679fe3c973ba9d26d0e0f',
    dec: 2,
    tickerSymbol: null,
    conf: '15 confirmations',
    eta: '~45 sec',
    minDeposit: 1
  },
  {
    id: 'sol',
    name: 'Solana',
    sym: 'SOL',
    coin: 'SOL',
    network: 'Solana network',
    address: '3LTzCu9PHAeYp43vbj2AqHApM7SPJ8dPci8tW9MXV5EQ',
    dec: 4,
    tickerSymbol: 'SOLUSDT',
    conf: '32 slots',
    eta: '~15 sec',
    minDeposit: 0.01
  }
]

export function listAssets() {
  return ASSETS
}

export function assetById(id: string): PayAsset | null {
  for (const asset of ASSETS) {
    if (asset.id === id) return asset
  }
  return null
}

/* Every coin the poller has to ask MEXC about, deduplicated. */
export function pollableCoins() {
  const seen: string[] = []
  for (const asset of ASSETS) {
    if (seen.indexOf(asset.coin) === -1) seen.push(asset.coin)
  }
  return seen
}
