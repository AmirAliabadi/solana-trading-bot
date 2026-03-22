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
    // This is a dummy strategy that just triggers a BUY signal immediately
    // Only used to verify that the modular architecture works.
    return {
      triggered: true,
      type: 'BUY',
      metrics: {
        rsiMet: { met: true, val: 50 },
        macdMet: { met: true, val: 0 },
        vwapMet: { met: true, val: livePrice }
      }
    };
  }
}
