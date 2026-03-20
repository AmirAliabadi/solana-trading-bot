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

The bot utilizes a strict, multi-layered filter of three institutional-grade indicators to execute exact Mean-Reversion trades:

1. **RSI (Relative Strength Index) - The Trigger**
   - **Buy Signal:** RSI drops below `30` (Heavily Oversold).
   - **Sell Signal:** RSI rallies above `70` (Heavily Overbought).
   - *Purpose:* Identifies extreme rubber-band deviations in price that are mathematically primed for an immediate, violent bounce.

2. **MACD (Moving Average Convergence Divergence) - The Momentum Filter**
   - **Buy Signal:** MACD Histogram flips Positive (`> 0`).
   - **Sell Signal:** MACD Histogram flips Negative (`< 0`).
   - *Purpose:* Prevents buying while an asset is still actively crashing. It forces the bot to wait until the exact moment the immediate downward momentum starts curving upwards.

3. **VWAP (Volume Weighted Average Price) - The Macro Filter**
   - **Buy Signal:** Live Price breaks *Above* the VWAP.
   - **Sell Signal:** Live Price breaks *Below* the VWAP.
   - *Purpose:* Acts as the ultimate safety net. It analyzes true market volume to guarantee you are trading in the direction of institutional money, preventing fake-outs.

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
