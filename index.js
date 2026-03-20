import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';
import url from 'url';

// Mints and Token configuration
const TOKENS = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    isNative: true
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    isNative: false
  }
};

const PROFIT_MARGIN = 1.0002; // A multiplier representing a 0.02% profit
const POLL_INTERVAL = 5000;   // 5 seconds delay between quotes
const SLIPPAGE_BPS = 50;      // 0.5% slippage

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class JupiterTrader {
  constructor() {
    this.connection = new Connection(
      process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    
    if (!process.env.PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY is not defined in .env');
    }
    
    try {
      this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
      console.log(`Wallet loaded: ${this.wallet.publicKey.toString()}`);
    } catch (e) {
      throw new Error('Invalid PRIVATE_KEY in .env. It should be a base58 encoded string.');
    }
  }

  async getTokenBalance(tokenSymbol) {
    const token = TOKENS[tokenSymbol.toUpperCase()];
    if (!token) throw new Error(`Unsupported token: ${tokenSymbol}`);

    if (token.isNative) {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / (10 ** token.decimals);
    } else {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(token.mint) }
      );

      if (tokenAccounts.value.length === 0) return 0;
      
      let balance = 0;
      for (const account of tokenAccounts.value) {
        balance += account.account.data.parsed.info.tokenAmount.uiAmount || 0;
      }
      return balance;
    }
  }

  async getQuote(inputToken, outputToken, amountStr, slippageBps = SLIPPAGE_BPS) {
    const input = TOKENS[inputToken];
    const output = TOKENS[outputToken];
    
    // Parse the amount string and multiply by 10^decimals to get atomic units (lamports / spl-token smallest unit)
    const amountInAtomic = Math.floor(parseFloat(amountStr) * (10 ** input.decimals));
    const apiUrl = `https://public.jupiterapi.com/quote?inputMint=${input.mint}&outputMint=${output.mint}&amount=${amountInAtomic}&slippageBps=${slippageBps}`;
    
    const response = await fetch(apiUrl);
    const quoteResponse = await response.json();
    
    if (quoteResponse.error) {
      throw new Error(`Jupiter Quote Error: ${quoteResponse.error}`);
    }
    
    return quoteResponse;
  }

  async executeSwap(quoteResponse) {
    console.log('Requesting swap transaction from Jupiter...');
    const response = await fetch('https://public.jupiterapi.com/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: this.wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true, 
        prioritizationFeeLamports: 'auto'
      })
    });

    const body = await response.json();
    
    if (body.error) {
      throw new Error(`Jupiter Swap Error: ${body.error}`);
    }

    const { swapTransaction } = body;
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([this.wallet]);

    const rawTransaction = transaction.serialize();
    console.log('Sending transaction...');
    
    const txid = await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight: process.env.SKIP_PREFLIGHT === 'true',
      maxRetries: 2
    });

    console.log(`Transaction sent: https://solscan.io/tx/${txid}`);

    console.log('Waiting for confirmation...');
    const latestBlockHash = await this.connection.getLatestBlockhash();
    
    const confirmation = await this.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid
    }, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('Swap completed successfully!');
    return txid;
  }

  async runArbitrage(startTokenSymbol, amountInStr) {
    const startToken = startTokenSymbol.toUpperCase();
    const targetToken = startToken === 'SOL' ? 'USDC' : 'SOL';

    if (!TOKENS[startToken] || !TOKENS[targetToken]) {
      throw new Error(`Invalid token. Supported tokens are SOL and USDC.`);
    }

    const initialAmountNum = parseFloat(amountInStr);
    console.log(`\n================ INITIAL SWAP ================`);
    console.log(`Action: Swapping ${initialAmountNum} ${startToken} to ${targetToken}...`);

    // Record balance before the swap
    const preBalanceTarget = await this.getTokenBalance(targetToken);

    // Phase 1: Initial Swap
    const initialQuote = await this.getQuote(startToken, targetToken, amountInStr);
    await this.executeSwap(initialQuote);

    // Wait slightly to ensure token balance updates are propagated to the RPC
    console.log(`\nWaiting 3 seconds for node synchronization to verify the received balance...`);
    await delay(3000);

    // Record balance after the swap
    const postBalanceTarget = await this.getTokenBalance(targetToken);
    const receivedAmount = postBalanceTarget - preBalanceTarget;
    
    if (receivedAmount <= 0) {
      console.warn(`WARNING: Failed to measure the received ${targetToken} balance increment (Measured: ${receivedAmount}). Reverting to quoted estimated amount.`);
    }
    
    // In rare cases RPC caching misleads us, fallback securely to estimated quoted amount
    const netReceivedAmountStr = (receivedAmount > 0 ? receivedAmount : (parseInt(initialQuote.outAmount) / (10 ** TOKENS[targetToken].decimals))).toString();
    
    console.log(`\nReceived ${parseFloat(netReceivedAmountStr).toFixed(TOKENS[targetToken].decimals)} ${targetToken} from the initial swap.`);

    // Target Calculation: initial target * multiplier
    const rawTargetOutputAmount = initialAmountNum * PROFIT_MARGIN;
    
    console.log(`\n================ POLLING FOR PROFIT ================`);
    console.log(`Goal: Reverse swap ${netReceivedAmountStr} ${targetToken} back to ${startToken}.`);
    console.log(`Minimum Required to trigger: ${rawTargetOutputAmount.toFixed(TOKENS[startToken].decimals)} ${startToken} (to secure exactly 0.02% minimum profit)`);
    console.log(`Polling every ${POLL_INTERVAL/1000} seconds...\n`);

    const targetOutputAtomic = Math.floor(rawTargetOutputAmount * (10 ** TOKENS[startToken].decimals));

    // Phase 2: Polling Loop
    while (true) {
      try {
        const reverseQuote = await this.getQuote(targetToken, startToken, netReceivedAmountStr);
        
        // Slippage applies to the reverseQuote. We must only execute if the absolute WORST case 
        // scenario output (otherAmountThreshold) is greater than our targeted profit margin.
        const worstCaseOutputAtomic = parseInt(reverseQuote.otherAmountThreshold);
        const quotedBestOutputAtomic = parseInt(reverseQuote.outAmount);

        // Convert exactly how much we'll get for UI displaying
        const quotedHumanOutput = quotedBestOutputAtomic / (10 ** TOKENS[startToken].decimals);
        const worstCaseOutputHuman = worstCaseOutputAtomic / (10 ** TOKENS[startToken].decimals);

        console.log(`[${new Date().toLocaleTimeString()}] Quoted: ~${quotedHumanOutput} ${startToken} | Worst Case (After slippage): ${worstCaseOutputHuman} ${startToken}`);

        if (worstCaseOutputAtomic >= targetOutputAtomic) {
          console.log(`\nPROFIT TARGET SECURED! Commencing reverse swap...`);
          await this.executeSwap(reverseQuote);
          console.log(`\nArbitrage successfully resolved for exactly 0.02% profit or higher!`);
          break; // Stop loop and exit successfully
        }

      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Quote error during polling: ${err.message}`);
      }
      
      await delay(POLL_INTERVAL);
    }
  }
}

async function main() {
  const asset = process.argv[2];
  const amount = process.argv[3];

  if (!asset || !amount || isNaN(parseFloat(amount))) {
    console.error('Usage: node index.js <SOL|USDC> <amount>');
    console.error('Example: node index.js SOL 3');
    process.exit(1);
  }

  try {
    const trader = new JupiterTrader();
    await trader.runArbitrage(asset, amount);
  } catch (error) {
    console.error('Fatal Trader Error:', error.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
