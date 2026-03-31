import { EMA, RSI } from 'technicalindicators';

export class TrendFollowingStrategy {
  constructor(config = {}) {
    this.name = "Trend Following (EMA Crossover)";
    this.version = "1.0.0";
    this.fastPeriod = config.EMA_FAST || 9;
    this.slowPeriod = config.EMA_SLOW || 21;
    this.rsiPeriod = 14;
  }

  getRequiredIndicators() {
    return ['EMA_FAST', 'EMA_SLOW', 'RSI'];
  }

  calculateIndicators(marketData) {
    const fastEma = EMA.calculate({ values: marketData.close, period: this.fastPeriod });
    const slowEma = EMA.calculate({ values: marketData.close, period: this.slowPeriod });
    const rsi = RSI.calculate({ values: marketData.close, period: this.rsiPeriod });

    return {
      fastEma: fastEma[fastEma.length - 1],
      slowEma: slowEma[slowEma.length - 1],
      latestRsi: rsi[rsi.length - 1]
    };
  }

  checkSignal(indicators, livePrice, currentAsset) {
    const { fastEma, slowEma, latestRsi } = indicators;
    const isBuy = currentAsset === 'USDC';

    // Trend following logic:
    // Buy when Fast EMA crosses Above Slow EMA AND RSI shows upward strength (> 50)
    // Sell when Fast EMA crosses Below Slow EMA AND RSI shows downward weakness (< 50)

    let emaMet = isBuy ? (fastEma > slowEma) : (fastEma < slowEma);
    let rsiMet = isBuy ? (latestRsi > 50) : (latestRsi < 50);

    const triggered = emaMet && rsiMet;

    return {
      triggered,
      type: triggered ? (isBuy ? 'BUY' : 'SELL') : null,
      metrics: {
        rsiMet: { met: rsiMet, val: latestRsi },
        macdMet: { met: emaMet, val: fastEma - slowEma }, // We'll map EMA diff to the MACD slot for display
        vwapMet: { met: true, val: slowEma } // Use slow EMA as "baseline" for the VWAP slot
      }
    };
  }

  getLogParts(indicators, livePrice, metrics) {
    const { fastEma, slowEma, latestRsi } = indicators;
    const { rsiMet, macdMet } = metrics;

    const rsiIcon = rsiMet.met ? '🟢' : '🔴';
    const emaIcon = macdMet.met ? '🟢' : '🔴';

    const priceStr = livePrice.toFixed(2).padStart(6, ' ');
    const fastStr = fastEma.toFixed(2).padStart(6, ' ');
    const slowStr = slowEma.toFixed(2).padStart(6, ' ');
    const rsiStr = latestRsi.toFixed(1).padStart(4, ' ');

    return [
      `Price: $${priceStr}`,
      `EMA(9/21): ${fastStr}/${slowStr} ${emaIcon}`,
      `RSI: ${rsiStr} ${rsiIcon}`
    ];
  }
}
