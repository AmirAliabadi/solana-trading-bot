# SOL/USDC Trading Bot (Jupiter)

A fully automated, modular Spot Trading Bot for the **SOL/USDC** pair on Solana. It fetches live market data from Binance, computes Technical Analysis indicators, and signals optimal trade entries/exits via the [Jupiter](https://jup.ag) Swap API. Trade signals are sent to **Discord** in real-time.

> **Status:** Virtual Simulation mode. The bot tracks live Jupiter quotes and PNL with full precision but does **not** sign or submit transactions. You execute the swap manually when the alarm fires.

---

## Features

- **8 Pluggable Strategies** — swap between algorithms via a single `.env` line, no code changes required
- **Profit Guard Layer** — wraps any strategy and blocks round-trips that don't clear a minimum profit threshold
- **ATR-Dynamic Stops** — the new `DYNAMIC_TRAILING` strategy scales stop-loss and profit targets with live market volatility
- **Stop-Loss on GridScalper** — hard floor exit to cap downside per trade
- **Price Impact Guard** — blocks trades when on-chain liquidity is too thin (configurable %)
- **Persistent State** — survives restarts; reads `trading_state.json` to resume the exact session
- **Multi-file Logging** — hourly-rotated console/file logs + dedicated trade CSV for audit trails
- **Discord Notifications** — startup ping with strategy name + profile, BUY/SELL alerts with price, PNL, and balances
- **Quiet Hours** — heartbeat is silenced between 10 PM and 6 AM PST automatically
- **Hourly Heartbeat** — periodic Discord status update with PNL, SOL/USDC balances, uptime, and trade count
- **Backtesting Engine** — replay all strategies against months of OHLCV history across multiple timeframes in one command

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
| `ACTIVE_STRATEGY` | Strategy to run (see list below) | `DYNAMIC_TRAILING` |
| `ACTIVE_STRATEGY_CONFIG` | Config profile filename inside `strategies/configs/` | `DYNAMIC_TRAILING-aggressive.json` |
| `BINANCE_INTERVAL` | Candle resolution for TA (`1m`, `5m`, `15m`, `1h`, …) | `15m` |
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

**Resume** after a restart (reads `trading_state.json` automatically):

```bash
node sol_usdc_trading_bot.js
```

---

## Strategies

The bot's strategy system is fully modular. Select a strategy in `.env` and optionally point to a config profile:

```env
ACTIVE_STRATEGY=DYNAMIC_TRAILING
ACTIVE_STRATEGY_CONFIG=DYNAMIC_TRAILING-aggressive.json
BINANCE_INTERVAL=15m
```

Each strategy ships with three config profiles in `strategies/configs/`: `default`, `conservative`, and `aggressive`.

---

### 1. `DYNAMIC_TRAILING` ⭐ New — Best Backtested Performance

**Philosophy:** A volatility-aware swing trading strategy that adapts its stop-loss and profit target dynamically to the current market's ATR (Average True Range). It only enters on high-confidence RSI divergence signals, avoiding entries during volatility panics.

**Logic:**
- **BUY** → Price forms a swing low AND RSI is *higher* than on the previous low (bullish divergence) AND RSI is below `RSI_BUY_MAX` AND ATR spike is not indicating a panic
- **SELL** → Price hits ATR-scaled take-profit OR ATR-scaled stop-loss OR trailing stop triggers (after gains) OR RSI exceeds `RSI_SELL_MIN`

**Why it beats fixed-% strategies:** During a SOL flash crash, ATR naturally widens — giving the bot more breathing room before stop-loss fires. During calm markets, ATR tightens — locking profits faster and stopping out gracefully.

**Config profiles (`strategies/configs/DYNAMIC_TRAILING-*.json`):**

| Profile | ATR Stop | ATR Target | ATR Trail | Entry RSI Max | Use Case |
|---|---|---|---|---|---|
| `aggressive` | 1.0× | 1.8× | 0.8× | RSI < 50 | More frequent trades, tighter exits |
| `default` | 1.5× | 2.5× | 1.2× | RSI < 45 | Balanced risk/reward |
| `conservative` | 2.0× | 3.5× | 1.8× | RSI < 40 | Patient swing trades, crash-resistant |

**Config keys:**

```json
{
  "ATR_PERIOD": 14,
  "ATR_STOP_MULT": 1.5,
  "ATR_PROFIT_MULT": 2.5,
  "ATR_TRAIL_MULT": 1.2,
  "ATR_PANIC_MULT": 2.5,
  "RSI_PERIOD": 14,
  "RSI_BUY_MAX": 45,
  "RSI_SELL_MIN": 65,
  "SWING_WINDOW": 5
}
```

**Backtested results (15m, 5 months Nov 2025–Mar 2026, starting 60 SOL):**

| Profile | PnL | Trades | Final SOL |
|---|---|---|---|
| `aggressive` | **+65.21%** | 51 | 99.12 |
| `conservative` | +37.15% | 51 | 82.29 |
| `default` | +34.34% | 61 | 80.60 |

---

### 2. `GRID_SCALPER`

**Philosophy:** Track the local price high while holding USDC. Buy when price dips a set percentage from that high. Sell mechanically when a fixed profit target is hit — or cut losses at the stop-loss.

**Logic:**
- **BUY** → Price drops `GRID_BUY_DROP_PCT`% from local high
- **SELL** → Price rises `GRID_SELL_TARGET_PCT`% above entry price
- **STOP** → Price drops `GRID_STOP_LOSS_PCT`% below entry price (hard floor)

**Display modes in the console log:**

| Mode displayed | Meaning |
|---|---|
| `📉 HUNTING DIPS` | Holding USDC — tracking local high, waiting for `GRID_BUY_DROP_PCT`% dip |
| `🎯 SCALPING TARGET \| Target: $X \| Stop: 🛑$X` | Holding SOL — waiting to hit profit target or stop-loss |
| `INITIALIZING...` | First poll only — bot is anchoring entry price to current live price |

**Config profiles (`strategies/configs/GRID_SCALPER-*.json`):**

| Profile | Buy Drop | Sell Target | Stop Loss | Use Case |
|---|---|---|---|---|
| `optimal` | 0.3% | 0.35% | 0.75% | High-frequency scalping |
| `default` | 1.0% | 1.0% | 1.5% | Moderate swings |
| `conservative` | 2.0% | 0.5% | 3.0% | Deep dip hunter |
| `aggressive` | 0.5% | 2.0% | 1.0% | Ride large moves |

> ⚠️ **Timeframe matters critically** for this strategy. The same conservative config that loses -38% on `1m` returns +32% on `1h`. Use `1h` or `15m` — never `1m`.

**Config keys:**

```json
{
  "GRID_BUY_DROP_PCT": 0.3,
  "GRID_SELL_TARGET_PCT": 0.35,
  "GRID_STOP_LOSS_PCT": 0.75
}
```

---

### 3. `MEAN_REVERSION`

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

### 4. `BOLLINGER_BANDS`

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

### 5. `TREND_FOLLOWING`

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

### 6. `SIMPLE_TREND`

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

### 7. `VOLUME_BREAKOUT`

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

> Best on `5m` or `15m` candles. Consistent positive PnL across all tested timeframes, making it a solid secondary strategy.

---

### 8. `ALWAYS_BUY` (Testing Only)

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
| 🚀 **Bot Initialized** | Blue | Once at startup — shows strategy name, profile, and starting portfolio |
| 📈 / 📉 **Trade Alert** | Green (buy) / Red (sell) | Each time a swap signal is triggered — includes price, SOL/USDC balances, PNL, and reason |
| 💓 **Hourly Heartbeat** | Orange | Every `HEARTBEAT_INTERVAL_MS` milliseconds (default: 1 hour) |

### Startup message

```
🚀 Bot Initialized
Strategy: DYNAMIC_TRAILING
Profile: aggressive
Portfolio: 60.0000 SOL
```

### Trade alert message

```
🚀 SOL/USDC Trading Bot Alert
Action: BUY SOL
Price: $128.45
Balances: 0.0500 SOL | 7707.00 USDC
PNL: +1.24% (+0.7440 SOL)
Strategy: DYNAMIC_TRAILING + Profit Guard (0.25%)
```

### Heartbeat message

```
💓 Hourly Heartbeat

Strategy: DYNAMIC_TRAILING + Profit Guard (0.25%)
Balances: 72.3100 SOL | 0.00 USDC
Live Price: $129.10

Session PNL: +20.52% (+12.312 SOL)
Mode: RSI: 38.2 🟢 | ATR: 1.842 (1.05x avg) 🟢 | Divergence: ⏳ Watching...

Session Trades: 18
Uptime: 3h 15m
```

**Quiet Hours:** The heartbeat is automatically silenced between **10 PM and 6 AM PST** to avoid noise during off-hours. Trade alerts still fire at any time.

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
# 150 days of 5-minute data starting Nov 1 2025
node download_history.js 2025-11-01 150 5m

# 150 days of 15-minute data (recommended for DYNAMIC_TRAILING)
node download_history.js 2025-11-01 150 15m
```

**Valid intervals:** `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `1w`

Output files are saved as `historical_data/<interval>/historical-YYYY-MM.csv` with columns:

```
timestamp, open, high, low, close, volume, quoteVolume, trades, takerBaseVolume, takerQuoteVolume
```

### 2. Run the Backtest Engine

The engine tests **all strategies × all config profiles simultaneously** and prints a ranked results table.

```bash
# Test all strategies on 15m data, starting with 60 SOL
node backtest.js --interval 15m

# Test a single strategy and profile
node backtest.js --strategy DYNAMIC_TRAILING --profile aggressive --interval 15m

# Test on 1h data
node backtest.js --interval 1h
```

**Backtest parameters:**
- Slippage: **0.5%** per swap (conservative estimate)
- Profit guard threshold: reads `PROFIT_THRESHOLD_PERCENT` from `.env` (default `0.25`)
- Warm-up: skips first 50 candles to allow indicators to stabilize

**Example output (15m, 5 months):**
```
┌──────────────────────────────────┬───────────┬────────┬──────────┐
│ name                             │ pnl       │ trades │ finalSol │
├──────────────────────────────────┼───────────┼────────┼──────────┤
│ DYNAMIC_TRAILING-aggressive      │ '65.21%'  │ 51     │ '99.12'  │
│ DYNAMIC_TRAILING-conservative    │ '37.15%'  │ 51     │ '82.29'  │
│ DYNAMIC_TRAILING-default         │ '34.34%'  │ 61     │ '80.60'  │
│ GRID_SCALPER-conservative        │ '25.89%'  │ 143    │ '75.53'  │
│ VOLUME_BREAKOUT-default          │ '7.13%'   │ 4      │ '64.28'  │
│ ...                              │ ...       │ ...    │ ...      │
└──────────────────────────────────┴───────────┴────────┴──────────┘
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
│   ├── DynamicTrailingStrategy.js  # ATR-dynamic stops + RSI divergence ⭐ NEW
│   ├── GridScalperStrategy.js      # Dip-buy + profit target + stop-loss
│   ├── MeanReversionStrategy.js    # RSI + MACD + VWAP
│   ├── BollingerBandStrategy.js    # BB bands + RSI
│   ├── TrendFollowingStrategy.js   # EMA crossover + RSI
│   ├── SimpleTrendStrategy.js      # % bounce / % pullback
│   ├── VolumeBreakoutStrategy.js   # Volume spike + trailing stop
│   ├── SimplePercentStrategy.js    # Fixed % targets
│   ├── ProfitGuardedStrategy.js    # Decorator: wraps any strategy
│   ├── AlwaysBuyStrategy.js        # Test harness only
│   └── configs/
│       ├── DYNAMIC_TRAILING-aggressive.json   ← backtested best performer
│       ├── DYNAMIC_TRAILING-default.json
│       ├── DYNAMIC_TRAILING-conservative.json
│       ├── GRID_SCALPER-optimal.json
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
    ├── 15m/                    # 15-minute OHLCV monthly files
    └── 1h/                     # 1-hour OHLCV monthly files
```

---

## Strategy Selection Guide

| Goal | Recommended Strategy | Config Profile | Timeframe |
|---|---|---|---|
| **Best overall performance** (backtested) | `DYNAMIC_TRAILING` | `aggressive` | `15m` |
| Crash-resistant swing trading | `DYNAMIC_TRAILING` | `conservative` | `15m` or `1h` |
| High-frequency grid scalping | `GRID_SCALPER` | `conservative` | `1h` |
| Volume-driven momentum | `VOLUME_BREAKOUT` | `conservative` | `15m` |
| Ranging/choppy market | `BOLLINGER_BANDS` | `conservative` | `15m` |
| Deep RSI oversold signals | `MEAN_REVERSION` | `default` | `15m` |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module 'sol_usdc_trading_bot.js'` | Running from the wrong directory | `cd jupiter-bot` then re-run |
| `Mode: INITIALIZING (warming up indicators...)` | Not enough candle history yet | Normal for first ~15–20 candles; wait for warm-up period |
| `Mode: INITIALIZING...` (persists beyond first poll) | `entryPrice = 0` — bug from older version | Delete `trading_state.json` and restart with `SOL <amount>` |
| `PROFIT: BLOCK 🛑` on every poll when holding SOL | Stop-loss being blocked by profit guard — bug from older version | Ensure you are running the latest code; stop-losses now bypass profit check |
| `PROFIT: BLOCK 🛑` on normal sells | Price hasn't recovered to entry + threshold yet | Expected behaviour — the guard is working. Wait for the target, or lower `PROFIT_THRESHOLD_PERCENT` |
| Bot never buys after selling | Profit guard buy check: current price must be ≤ previous sell price - threshold | Price needs to dip enough from the last sell for a re-entry to make sense |
| `DYNAMIC_TRAILING` never fires a buy signal | RSI divergence conditions are strict by design | Normal during sustained downtrends. Lower `RSI_BUY_MAX` (e.g., 50→55) for the `aggressive` profile to increase frequency |
| `Market data temporarily unavailable` | Binance API rate limit or network blip | Bot retries automatically every `POLL_INTERVAL` |
| `Trading quotes temporarily unavailable` | Jupiter API timeout | Bot retries automatically; usually resolves within 1–2 polls |
| No heartbeat received in Discord | Webhook URL missing or incorrect | Check `DISCORD_WEBHOOK_URL` in `.env` starts with `https://discord.com/api/webhooks/` |
| Heartbeat fires too rarely / too often | `HEARTBEAT_INTERVAL_MS` set to wrong value | Adjust in `.env`; `3600000` = 1 hour, `300000` = 5 min |
| No heartbeat between 10 PM and 6 AM | Quiet hours feature is active | Expected — heartbeat resumes after 6 AM PST automatically |
