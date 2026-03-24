import { SMA, RSI, MACD, BollingerBands } from 'technicalindicators';

export default class SimpleTrendStrategy {
    constructor(config = {}) {
        this.name = "SIMPLE_TREND";
        this.lastLow = null;
        this.lastHigh = null;
    }

    calculateIndicators(priceHistory) {
        // This strategy doesn't need complex indicators, but for compatibility:
        return {
            rsi: [50],
            macd: [{ histogram: 0 }],
            vwap: [0]
        };
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        let triggered = false;
        let type = null;

        if (currentAsset === 'USDC') {
            // While in USDC, track the bottom
            if (this.lastLow === null || currentPrice < this.lastLow) {
                this.lastLow = currentPrice;
            }

            // Reset Peak since we're not holding
            this.lastHigh = null;

            // Trigger BUY on 3% rise from the low
            if (currentPrice >= this.lastLow * 1.03) {
                triggered = true;
                type = 'BUY';
            }
        } else if (currentAsset === 'SOL') {
            // While in SOL, track the peak
            if (this.lastHigh === null || currentPrice > this.lastHigh) {
                this.lastHigh = currentPrice;
            }

            // Reset Bottom since we're holding
            this.lastLow = null;

            // Trigger SELL on 4% drop from the peak
            if (currentPrice <= this.lastHigh * 0.96) {
                triggered = true;
                type = 'SELL';
            }
        }

        return { triggered, type, metrics: { lastLow: this.lastLow, lastHigh: this.lastHigh } };
    }
}

