import { SMA, RSI, MACD, BollingerBands } from 'technicalindicators';

export default class SimpleTrendStrategy {
    constructor(config = {}) {
        this.name = "SIMPLE_TREND";
        this.version = "1.0.0";
        this.lastLow = null;
        this.lastHigh = null;
        
        // Percentages (Default 3% / 4%)
        this.buyThreshold = (parseFloat(config.SIMPLE_BUY_PCT) || 3.0) / 100;
        this.sellThreshold = (parseFloat(config.SIMPLE_SELL_PCT) || 4.0) / 100;
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

            // Trigger BUY on X% rise from the low
            if (currentPrice >= this.lastLow * (1 + this.buyThreshold)) {
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

            // Trigger SELL on X% drop from the peak
            if (currentPrice <= this.lastHigh * (1 - this.sellThreshold)) {
                triggered = true;
                type = 'SELL';
            }
        }

        return { triggered, type, metrics: { lastLow: this.lastLow, lastHigh: this.lastHigh } };
    }

    getLogParts(indicators, livePrice, metrics) {
        let parts = [];
        if (this.lastLow) {
            const dist = ((livePrice - this.lastLow) / this.lastLow) * 100;
            parts.push(`LOW: ${this.lastLow.toFixed(2)} [${dist.toFixed(1)}%]`);
        } else if (this.lastHigh) {
            const dist = ((livePrice - this.lastHigh) / this.lastHigh) * 100;
            parts.push(`PEAK: ${this.lastHigh.toFixed(2)} [${dist.toFixed(1)}%]`);
        }
        return parts;
    }
}

