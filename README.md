# Solana Auto-Compounding TA Trading Bot (Virtual)

This is a fully automated Crypto Spot Trading Bot designed specifically for the **SOL/USDC** pair using the Jupiter `v6` Swap API. It watches the market on the 1-minute timeframe using data directly from Binance and mathematically determines optimal trade entries using purely quantitative Technical Analysis.

Currently, the bot is operating as a **Virtual Simulation**. It accurately queries the blockchain for live quotes and strictly tracks PNL and gas fees, but does *not* sign live transactions with your private key. 

### Core Features
- **Mean-Reversion Strategy:** Buys exact bottoms and sells exact tops using Extreme RSI Divergences (Overbought/Oversold).
- **Trend Confirmation Filters:** Protects from "falling knives" by requiring MACD Reversal alignment and Volume Weighted Average Price (VWAP) breakouts.
- **Auto-Compounding:** Re-invests 100% of profit back into the active trading stack natively.
- **Persistent State Tracking:** Constantly writes your current real-time portfolio balance to a local `json` database so you can seamlessly shut down the bot and resume exactly where you left off.
- **Hourly Native Logs:** Spits out clean, professional metrics directly to the console and archives everything cleanly in rotated background files.

---

## 📈 Technical Analysis Strategy

The bot's core logic is now **Modular**. You can swap between different trading algorithms without touching the main engine.

### **Available Strategies:**
1.  **`MEAN_REVERSION` (Default):** Uses RSI, MACD, and VWAP to find overextended price points (Buys low, Sells high).
2.  **`TREND_FOLLOWING`:** Uses EMA Crossovers (9/21) and RSI momentum to capture breakout trends.
3.  **`BOLLINGER_BANDS`:** Uses volatility bands (20, 2) to identify price extremes.
4.  **`SIMPLE_TREND`:** A momentum-based approach that triggers on fixed percentage moves (e.g., 3% rise to buy, 4% drop to sell).
5.  **`ALWAYS_BUY` (Testing):** A test strategy that triggers a buy signal on every poll.

### **How to Switch Strategies:**
Simply update your `.env` file:
```env
ACTIVE_STRATEGY=ALWAYS_BUY
```
The bot utilizes a strict, multi-layered filter of three institutional-grade indicators to execute exact Mean-Reversion trades. You can easily adjust the "aggressiveness" of the bot in your `.env` file by changing the RSI thresholds:

1. **RSI (Relative Strength Index) - The Trigger**
   - **Buy Signal:** RSI drops below `BUY_RSI_THRESHOLD` (Default: **40**).
   - **Sell Signal:** RSI rallies above `SELL_RSI_THRESHOLD` (Default: **60**).
   - *Strategy:* A higher BUY threshold (e.g., 40 instead of 30) and a lower SELL threshold (e.g., 60 instead of 70) will lead to much higher trade frequency.

4. **Simple Trend Thresholds (Percentage Distance)**
   - **Buy Signal:** Price rises by `SIMPLE_TREND_BUY_PCT` (Default: **3.0%**) from the local bottom.
   - **Sell Signal:** Price drops by `SIMPLE_TREND_SELL_PCT` (Default: **4.0%**) from the local peak.
   - *Logic:* This strategy ignores complex TA indicators and relies purely on price momentum and "bounce" strength.

5. **Price Impact Guard (Liquidity Filter)**
   - **Threshold:** `MAX_PRICE_IMPACT` (Default: **0.1%**).
   - **Purpose:** Even if all TA signals are green, the bot will block the trade if market liquidity is too thin to support your order size without significant slippage.

2. **MACD (Moving Average Convergence Divergence) - The Momentum Filter**
   - **Buy Signal:** MACD Histogram flips Positive (`> 0`).
   - **Sell Signal:** MACD Histogram flips Negative (`< 0`).
   - **Config:** You can disable this by setting `USE_MACD=false` or change the periods (`12, 26, 9`) via environment variables.
   - *Purpose:* Prevents buying while an asset is still actively crashing. It forces the bot to wait until the exact moment the immediate downward momentum starts curving upwards.

3. **VWAP (Volume Weighted Average Price) - The Macro Filter**
   - **Buy Signal:** Live Price breaks *Above* the VWAP (Adjustable via `VWAP_OFFSET_PERCENT`).
   - **Sell Signal:** Live Price breaks *Below* the VWAP (Adjustable via `VWAP_OFFSET_PERCENT`).
   - **Config:** You can disable this entirely by setting `USE_VWAP=false`.
   - *Strategy:* Adding an offset (e.g., 0.1%) allows the bot to trigger a trade slightly *before* the price physically crosses the VWAP line, which is useful in high-momentum breakouts.

*Note: The bot requires ALL THREE conditions to align simultaneously before it will trigger an alarm and flip its active portfolio state.*

---

## 🚀 How to Run in a Clean Environment

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) installed on your machine (v18 or higher recommended).

### 2. Clone the Repository
Pull the code down to your local machine:
```bash
git clone https://github.com/AmirAliabadi/solana-trading-bot.git
cd solana-trading-bot
```

### 3. Install Dependencies
Install all the required trading libraries (`technicalindicators`, `dotenv`, `winston`, `@solana/web3.js`, etc.):
```bash
npm install
```

### 4. Configure Your Environment Variables
The bot requires a `.env` file to function properly. 
1. Copy the provided example file: 
```bash
cp .env.example .env
```
2. Open the newly created `.env` file in your editor and optionally fill in your Private Key (if live trading is enabled) and custom `POLL_INTERVAL` configuration.


### 5. Start the Trading Bot
To initialize the very first session, you must tell the script what token you are starting with, and how much of it you virtually hold. 

For example, if you want to simulated trade starting with 60 SOL:
```bash
node sol_usdc_trading_bot.js SOL 60
```

If you ever want to gracefully stop the bot (using `CTRL+C`) and start it back up later, you don't need to feed it any arguments. Just run:
```bash
node sol_usdc_trading_bot.js
```
The bot will automatically read the local `trading_state.json` file it created, recover your exact portfolio balances, calculate your PNL, and seamlessly pick up right where it left off!

---

---

## 🛡️ Profit Guard Security Layer
To protect your balance from "wash trades" (where a signal triggers but the price hasn't moved enough to cover slippage), the bot includes a mandatory **Profit Guard**.

- **How it works:** Every time the bot completes a swap, it records the exact **Execution Price**. It will then **block** any automated reversal signals unless the current price guarantees at least a net profit (after slippage).
- **Configuration:** Update `PROFIT_THRESHOLD_PERCENT=0.2` (Default: **0.2%**) in your `.env`.

---

## 🧪 Backtesting & Historical Analysis

The bot includes a standalone high-fidelity backtesting engine (`backtest.js`) that allows you to simulate all strategies against your actual recorded history.

### **1. Download High-Res History**
The bot includes a script to fetch professional market data directly from Binance:
```bash
node download_history.js 2026-01-01 31
```
*This fetches 31 days of 1-minute data starting from Jan 1st into `historical_data/`.*

### **2. Run a Deep Simulation**
The engine automatically aggregates all historical files, sorts them chronologically, and applies a **1% safety slippage cap** for high-fidelity results:
```bash
node backtest.js 60 SOL
```
*This simulates all registered strategies across your entire multi-month historical archive.*

### **3. Captured Fields**
- `timestamp`: ISO 8601 UTC time.
- `price`: Live SOL/USDC price.
- `rsi`: Relative Strength Index.
- `macd_h`: MACD Histogram value.
- `vwap`: Volume Weighted Average Price.
- `impact_pct`: Current market slippage/impact.

### **4. Cooldown Settings**
- `POST_SWAP_DELAY_MS=5000`: How long the bot pauses after a success before resuming the monitor.
