export class AlwaysBuyStrategy {
  constructor(config = {}) {
    this.name = "Test Strategy (Always Buy)";
  }

  getRequiredIndicators() {
    return ['RSI']; // Just need something to fill the slot
  }

  calculateIndicators(marketData) {
    return { latestRsi: 50 };
  }

  checkSignal(indicators, livePrice, currentAsset) {
    const isBuy = currentAsset === 'USDC';
    // This is a dummy strategy that just triggers a BUY signal immediately
    // Only used to verify that the modular architecture works.
    return {
      triggered: true,
      type: isBuy ? 'BUY' : 'SELL',
      metrics: {
        rsiMet: { met: true, val: 50 },
        macdMet: { met: true, val: 0 },
        vwapMet: { met: true, val: livePrice }
      }
    };
  }

  getLogParts(indicators, livePrice, metrics) {
    return [`Price: $${livePrice.toFixed(2).padStart(6, ' ')}`, `STATUS: ALWAYS BUY MODE` ];
  }
}
