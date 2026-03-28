# SOL/USDC Trading Bot (Jupiter)

A fully automated, modular Spot Trading Bot for the **SOL/USDC** pair on Solana. It fetches live market data from Binance, computes Technical Analysis indicators, and signals optimal trade entries/exits via the [Jupiter](https://jup.ag) Swap API. Trade signals are sent to **Discord** in real-time.

> **Status:** Virtual Simulation mode. The bot tracks live Jupiter quotes and PNL with full precision but does **not** sign or submit transactions. You execute the swap manually when the alarm fires.

---

## Features

- **7 Pluggable Strategies** — swap between algorithms via a single `.env` line, no code changes required
- **Profit Guard Layer** — wraps any strategy and blocks round-trips that don't clear a minimum profit threshold
- **Stop-Loss on GridScalper** — hard floor exit to cap downside per trade
- **Price Impact Guard** — blocks trades when on-chain liquidity is too thin (configurable %)
- **Persistent State** — survives restarts; reads `trading_state.json` to resume the exact session
- **Multi-file Logging** — hourly-rotated console/file logs + dedicated trade CSV for audit trails
- **Discord Notifications** — startup ping, BUY/SELL alerts with price, PNL, and strategy name
- **Hourly Heartbeat** — periodic Discord status update with PNL, mode, uptime, and trade count
- **Backtesting Engine** — replay all strategies against months of OHLCV history in one command

---

## Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` — the key fields are:

| Variable | Description | Default |
|---|---|---|
| `ACTIVE_STRATEGY` | Strategy to run (see list below) | `GRID_SCALPER` |
| `ACTIVE_STRATEGY_CONFIG` | Config profile filename inside `strategies/configs/` | `GRID_SCALPER-optimal.json` |
| `BINANCE_INTERVAL` | Candle resolution for TA (`1m`, `5m`, `15m`, `1h`, …) | `5m` |
| `POLL_INTERVAL` | How often the bot polls, in milliseconds | `30000` |
| `MAX_PRICE_IMPACT` | Block trades above this on-chain price impact % | `0.1` |
| `PROFIT_THRESHOLD_PERCENT` | Minimum % gain required before allowing a reverse swap | `0.25` |
| `POST_SWAP_DELAY_MS` | Pause after a swap before resuming polling | `5000` |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL for trade alerts and heartbeat | *(your URL)* |
| `HEARTBEAT_INTERVAL_MS` | How often to post a status heartbeat to Discord (ms) | `3600000` (1 hr) |
| `ENABLE_DATA_LOGGING` | Write live TA data to `data_logs/` CSV for later backtesting | `true` |

### 4. Start the Bot

> ⚠️ **Run from inside the `jupiter-bot/` directory**, not the parent folder.

**First run** — pass your starting token and amount:

```bash
node sol_usdc_trading_bot.js SOL 60
```

If you start with **SOL** and no prior trade history, the bot has no cost basis yet. On the first poll it will automatically anchor the entry price to the current live SOL price and log:

```
[Session] No entry price found. Anchoring cost basis to current price: $XX.XX
```

GridScalper will then immediately switch to `🎯 SCALPING TARGET` mode and begin tracking exits from that anchor price.

**Resume** after a restart (reads `trading_state.json` automatically):

```bash
node sol_usdc_trading_bot.js
```

---

## Strategies

The bot's strategy system is fully modular. Select a strategy in `.env` and optionally point to a config profile:

```env
ACTIVE_STRATEGY=GRID_SCALPER
ACTIVE_STRATEGY_CONFIG=GRID_SCALPER-optimal.json
```

Each strategy ships with three config profiles in `strategies/configs/`: `default`, `conservative`, and `aggressive`.

---

### 1. `GRID_SCALPER` ⭐ Recommended for 0.025%/day target

**Philosophy:** Track the local price high while holding USDC. Buy when price dips a set percentage from that high. Sell mechanically when a fixed profit target is hit — or cut losses at the stop-loss.

**Logic:**
- **BUY** → Price drops `GRID_BUY_DROP_PCT`% from local high
- **SELL** → Price rises `GRID_SELL_TARGET_PCT`% above entry price
- **STOP** → Price drops `GRID_STOP_LOSS_PCT`% below entry price (hard floor)

**Why it hits the daily target:** Exits are deterministic, not indicator-based. You engineer the profit per trade. With the `optimal` profile (0.3% dip / 0.35% target), SOL's intraday volatility provides multiple opportunities daily.

**Display modes in the console log:**

| Mode displayed | Meaning |
|---|---|
| `📉 HUNTING DIPS` | Holding USDC — tracking local high, waiting for `GRID_BUY_DROP_PCT`% dip |
| `🎯 SCALPING TARGET \| Target: $X \| Stop: 🛑$X` | Holding SOL — waiting to hit profit target or stop-loss |
| `INITIALIZING...` | First poll only — bot is anchoring entry price to current live price |

**Config profiles (`strategies/configs/GRID_SCALPER-*.json`):**

| Profile | Buy Drop | Sell Target | Stop Loss | Use Case |
|---|---|---|---|---|
| `optimal` | 0.3% | 0.35% | 0.75% | **0.025%/day target** |
| `default` | 1.0% | 1.0% | 1.5% | Moderate swings |
| `conservative` | 2.0% | 0.5% | 3.0% | Deep dip hunter |
| `aggressive` | 0.5% | 2.0% | 1.0% | Ride large moves |

**Config keys:**

```json
{
  "GRID_BUY_DROP_PCT": 0.3,
  "GRID_SELL_TARGET_PCT": 0.35,
  "GRID_STOP_LOSS_PCT": 0.75
}
```

---

### 2. `MEAN_REVERSION`

**Philosophy:** SOL oscillates between extremes. Buy when it's oversold, sell when it's overbought.

**Logic:**
- **BUY** → RSI < `BUY_RSI_THRESHOLD` AND (optionally) MACD histogram > 0 AND price ≥ VWAP
- **SELL** → RSI > `SELL_RSI_THRESHOLD` AND (optionally) MACD histogram < 0 AND price ≤ VWAP

**Config keys:**

```json
{
  "BUY_RSI_THRESHOLD": 40,
  "SELL_RSI_THRESHOLD": 60,
  "USE_MACD": true,
  "MACD_FAST_PERIOD": 12,
  "MACD_SLOW_PERIOD": 26,
  "MACD_SIGNAL_PERIOD": 9,
  "USE_VWAP": false,
  "VWAP_OFFSET_PERCENT": 0.0
}
```

> **Note:** Setting `USE_MACD: true` significantly reduces false signals in trending markets. `USE_VWAP: false` is recommended on timeframes shorter than 1h where the rolling VWAP loses daily-session meaning.

---

### 3. `BOLLINGER_BANDS`

**Philosophy:** Use statistical volatility bands as natural support/resistance levels.

**Logic:**
- **BUY** → Price touches or breaks below Lower Band AND RSI < 45
- **SELL** → Price touches or breaks above Upper Band AND RSI > 55

**Config keys:**

```json
{
  "BB_PERIOD": 20,
  "BB_STDDEV": 2
}
```

Best suited to **ranging/choppy** SOL markets. In strong trends, price can "walk the band" — combine with a directional bias filter if needed.

---

### 4. `TREND_FOLLOWING`

**Philosophy:** Capture breakouts by riding EMA crossovers with RSI momentum confirmation.

**Logic:**
- **BUY** → EMA(fast) crosses above EMA(slow) AND RSI > 50
- **SELL** → EMA(fast) crosses below EMA(slow) AND RSI < 50

**Config keys:**

```json
{
  "EMA_FAST": 9,
  "EMA_SLOW": 21
}
```

> ⚠️ EMA crossovers are lagging. This strategy underperforms in choppy/sideways conditions and can suffer whipsaws. Best used on the `1h` timeframe or above.

---

### 5. `SIMPLE_TREND`

**Philosophy:** Pure price momentum. Buy after a confirmed bounce off a bottom; sell after a pullback from a peak.

**Logic:**
- **BUY** → Price rises `SIMPLE_BUY_PCT`% from the tracked local low
- **SELL** → Price drops `SIMPLE_SELL_PCT`% from the tracked local high

**Config keys:**

```json
{
  "SIMPLE_BUY_PCT": 3.0,
  "SIMPLE_SELL_PCT": 4.0
}
```

> The default thresholds (3% / 4%) require large moves, giving very low trade frequency. At $84 SOL this means ~$5–6 swings. Best used as a **macro/swing** strategy over longer periods.

---

### 6. `VOLUME_BREAKOUT`

**Philosophy:** Wait for institutional-grade volume spikes that signal conviction breakouts.

**Logic:**
- **BUY** → Current volume > `VOLUME_MULTIPLIER` × 20-period volume SMA AND price is increasing AND RSI < `BUY_RSI`
- **SELL** → Price drops 3% from peak (trailing stop) OR RSI > `SELL_RSI`

**Config keys:**

```json
{
  "VOLUME_MA_PERIOD": 20,
  "VOLUME_MULTIPLIER": 3.0,
  "STOP_LOSS_PCT": 3.0,
  "SELL_RSI_THRESHOLD": 70
}
```

> Best on `1m` or `5m` candles. On `15m`+ timeframes, 3x volume spikes become very rare. Lower `VOLUME_MULTIPLIER` to ~1.5 for higher signal frequency.

---

### 7. `ALWAYS_BUY` (Testing Only)

Immediately triggers BUY or SELL on every poll cycle. Used solely to verify the modular strategy architecture and Profit Guard wrapper are working. **Do not use for live trading.**

---

## Profit Guard (Wraps All Strategies)

Every strategy is automatically wrapped by a **Profit Guard** layer when `PROFIT_THRESHOLD_PERCENT > 0`.

**How it works:**
1. After each swap, the bot saves the exact execution price to `trading_state.json`
2. Before any reverse swap fires, the Profit Guard checks whether the current price guarantees at least `PROFIT_THRESHOLD_PERCENT` net gain
3. If not, it **blocks** the signal and logs `PROFIT: BLOCK 🛑`

```env
PROFIT_THRESHOLD_PERCENT=0.25   # Require at least 0.25% gain before reversing
```

Set to `0` to disable.

**Stop-Loss Bypass:** Stop-loss exits always pass through the Profit Guard regardless of the profit threshold. A stop-loss is an emergency exit at a loss by design — requiring it to clear a profit threshold would defeat its purpose. Stop-loss exits are logged as `PROFIT: OK ✅` (bypassed).

**Profit Guard decision flow:**
```
Signal triggered?
  └─ No  → no trade
  └─ Yes → entryPrice set?
              └─ No  → allow (no history)
              └─ Yes → STOP_LOSS signal?
                          └─ Yes → ✅ allow immediately (bypass)
                          └─ No  → profit threshold met?
                                      └─ Yes → ✅ PROFIT: OK
                                      └─ No  → ❌ PROFIT: BLOCK
```

---

## Price Impact Guard

Even if all TA signals are green, the bot will block a trade if it detects thin on-chain liquidity.

```env
MAX_PRICE_IMPACT=0.1   # Block any swap that would cause >0.1% price impact
```

The impact % is read directly from Jupiter's quote response — it reflects your actual order's market depth in real time.

---

## Discord Notifications

The bot sends three types of Discord messages via the webhook configured in `DISCORD_WEBHOOK_URL`:

| Event | Colour | When it fires |
|---|---|---|
| 🚀 **Bot Initialized** | Blue | Once at startup — shows strategy name and starting portfolio |
| 📈 / 📉 **Trade Alert** | Green (buy) / Red (sell) | Each time a swap signal is triggered — includes price, PNL, and reason |
| 💓 **Hourly Heartbeat** | Orange | Every `HEARTBEAT_INTERVAL_MS` milliseconds (default: 1 hour) |

### Heartbeat message

The heartbeat fires automatically on the next poll after the interval expires. It sends a concise snapshot directly to your Discord channel:

```
💓 Hourly Heartbeat

Strategy: GRID_SCALPER + Profit Guard (0.25%)
Holding: 60.0000 SOL @ $83.42

Session PNL: +0.12% (+0.0720 SOL)
Mode: 🎯 SCALPING TARGET | Target: $83.67 | Stop: 🛑$82.75

Session Trades: 2
Uptime: 3h 15m
```

**Tune the interval:**

```env
# Default — one update per hour
HEARTBEAT_INTERVAL_MS=3600000

# During testing — fire every 5 minutes to verify delivery
HEARTBEAT_INTERVAL_MS=300000
```

> The heartbeat counter and trade count reset each time the bot process restarts. Uptime reflects the current process lifetime only.

---

## Backtesting

### 1. Download Historical Data

Fetch OHLCV data from Binance and save it month-by-month to `historical_data/<interval>/`:

```bash
# 150 days of 1-minute data starting Nov 1 2025
node download_history.js 2025-11-01 150 1m

# 150 days of 1-hour data (faster, recommended for first run)
node download_history.js 2025-11-01 150 1h
```

**Valid intervals:** `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `1w`

Output files are saved as `historical_data/<interval>/historical-YYYY-MM.csv` with columns:

```
timestamp, open, high, low, close, volume, quoteVolume, trades, takerBaseVolume, takerQuoteVolume
```

### 2. Run the Backtest Engine

The engine tests **all strategies × all config profiles simultaneously** and prints a ranked results table:

```bash
# Start with 60 SOL, use 1h data
node backtest.js 60 SOL 1h

# Start with 5000 USDC, use 1m data
node backtest.js 5000 USDC 1m
```

**Backtest parameters:**
- Slippage: **0.5%** per swap (conservative estimate)
- Profit guard threshold: reads `PROFIT_THRESHOLD_PERCENT` from `.env` (default `0.25`)
- Warm-up: skips first 50 candles to allow indicators to stabilize

**Example output:**
```
Strategy                           :    PNL% | Trades
GRID_SCALPER-optimal               :  +12.45% |    47
BOLLINGER_BANDS-conservative       :   +8.11% |    22
MEAN_REVERSION-default             :   +5.33% |    14
...
```

---

## Logging

| Log Type | Location | Rotation | Contents |
|---|---|---|---|
| Console + file | `logs/trading-bot-YYYY-MM-DD-HH.log` | Hourly | Full poll output, signals, errors |
| Trade history | `logs/trades-YYYY-MM-DD.csv` | Daily | `timestamp, type, inputAmt, inputToken, outputAmt, outputToken, price` |
| TA data feed | `data_logs/market-feed-YYYY-MM-DD-HH.csv` | Hourly | `timestamp, price, rsi, macd_h, vwap, impact_pct` (if `ENABLE_DATA_LOGGING=true`) |

---

## Project Structure

```
jupiter-bot/
├── sol_usdc_trading_bot.js     # Main bot engine + polling loop
├── backtest.js                 # Standalone backtesting engine
├── download_history.js         # Binance OHLCV historical data fetcher
├── trading_state.json          # Live session state (auto-managed)
├── .env                        # Your local config (not committed)
├── .env.example                # Config template
│
├── strategies/
│   ├── GridScalperStrategy.js      # Dip-buy + profit target + stop-loss
│   ├── MeanReversionStrategy.js    # RSI + MACD + VWAP
│   ├── BollingerBandStrategy.js    # BB bands + RSI
│   ├── TrendFollowingStrategy.js   # EMA crossover + RSI
│   ├── SimpleTrendStrategy.js      # % bounce / % pullback
│   ├── VolumeBreakoutStrategy.js   # Volume spike + trailing stop
│   ├── ProfitGuardedStrategy.js    # Decorator: wraps any strategy
│   ├── AlwaysBuyStrategy.js        # Test harness only
│   └── configs/
│       ├── GRID_SCALPER-optimal.json       ← tuned for 0.025%/day
│       ├── GRID_SCALPER-default.json
│       ├── GRID_SCALPER-conservative.json
│       ├── GRID_SCALPER-aggressive.json
│       ├── MEAN_REVERSION-default.json
│       ├── MEAN_REVERSION-conservative.json
│       ├── MEAN_REVERSION-aggressive.json
│       └── ...
│
├── utils/
│   └── notify.js               # Discord webhook helper
│
├── logs/                       # Hourly rotated bot logs + trade CSV
├── data_logs/                  # Hourly live TA feed CSVs
└── historical_data/
    ├── 1m/                     # 1-minute OHLCV monthly files
    ├── 5m/                     # 5-minute OHLCV monthly files
    └── 1h/                     # 1-hour OHLCV monthly files
```

---

## Strategy Selection Guide

| Goal | Recommended Strategy | Config Profile | Timeframe |
|---|---|---|---|
| **0.025%/day** (primary target) | `GRID_SCALPER` | `optimal` | `5m` |
| Capture large swings | `GRID_SCALPER` | `aggressive` | `15m` |
| Ranging market | `BOLLINGER_BANDS` | `conservative` | `15m` |
| Trending market | `TREND_FOLLOWING` | `default` | `1h` |
| Deep RSI signals | `MEAN_REVERSION` | `default` | `15m` |
| Volume-driven moves | `VOLUME_BREAKOUT` | `aggressive` | `5m` |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module 'sol_usdc_trading_bot.js'` | Running from the wrong directory | `cd jupiter-bot` then re-run |
| `Mode: INITIALIZING...` (persists beyond first poll) | `entryPrice = 0` — bug from older version | Delete `trading_state.json` and restart with `SOL <amount>` |
| `PROFIT: BLOCK 🛑` on every poll when holding SOL | Stop-loss being blocked by profit guard — bug from older version | Ensure you are running the latest code; stop-losses now bypass profit check |
| `PROFIT: BLOCK 🛑` on normal sells | Price hasn't recovered to entry + threshold yet | Expected behaviour — the guard is working. Wait for the target, or lower `PROFIT_THRESHOLD_PERCENT` |
| Bot never buys after selling | Profit guard buy check: current price must be ≤ previous sell price - threshold | Price needs to dip enough from the last sell for a re-entry to make sense |
| `Market data temporarily unavailable` | Binance API rate limit or network blip | Bot retries automatically every `POLL_INTERVAL` |
| `Trading quotes temporarily unavailable` | Jupiter API timeout | Bot retries automatically; usually resolves within 1–2 polls |
| No heartbeat received in Discord | Webhook URL missing or incorrect | Check `DISCORD_WEBHOOK_URL` in `.env` starts with `https://discord.com/api/webhooks/` |
| Heartbeat fires too rarely / too often | `HEARTBEAT_INTERVAL_MS` set to wrong value | Adjust in `.env`; `3600000` = 1 hour, `300000` = 5 min |
