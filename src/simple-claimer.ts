#!/usr/bin/env node
import { ethers } from 'ethers';
import Safe from '@safe-global/protocol-kit';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || args.includes('-d');

// Configuration
const config = {
  // Polygon Mainnet
  mainnet: {
    chainId: 137,
    ctfAddress: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    usdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    polymarketApi: 'https://data-api.polymarket.com',
  },
  // Mumbai Testnet
  testnet: {
    chainId: 80001,
    ctfAddress: '0x7D8610E9567d2a6C9FBB66a99Fb1438587be9F0E',
    usdcAddress: '0xe11A86849d99F524cAC3E7A0Ec1241828e332C62',
    polymarketApi: 'https://data-api-testnet.polymarket.com',
  },
};

const isTestMode = process.env.TEST_MODE === 'true';
const currentConfig = isTestMode ? config.testnet : config.mainnet;

interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

class SimplePolymarketClaimer {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private safe?: Safe;
  private proxyAddress: string;
  
  constructor() {
    const rpcUrl = process.env.RPC_URL;
    const privateKey = process.env.PRIVATE_KEY;
    this.proxyAddress = process.env.PROXY_ADDRESS || '';
    
    if (!rpcUrl || !privateKey || !this.proxyAddress) {
      throw new Error('Missing required environment variables: RPC_URL, PRIVATE_KEY, PROXY_ADDRESS');
    }
    
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, this.provider);
  }
  
  async initialize() {
    console.log('🔧 Initializing claimer...');
    
    // Verify network
    const network = await this.provider.getNetwork();
    if (network.chainId !== BigInt(currentConfig.chainId)) {
      throw new Error(`Wrong network. Expected chain ${currentConfig.chainId}, got ${network.chainId}`);
    }
    
    // Verify contract addresses exist on-chain
    const ctfCode = await this.provider.getCode(currentConfig.ctfAddress);
    const usdcCode = await this.provider.getCode(currentConfig.usdcAddress);
    
    if (ctfCode === '0x' || ctfCode.length < 10) {
      throw new Error(`CTF contract not found at ${currentConfig.ctfAddress}`);
    }
    if (usdcCode === '0x' || usdcCode.length < 10) {
      throw new Error(`USDC contract not found at ${currentConfig.usdcAddress}`);
    }
    
    // Verify proxy is a contract
    const proxyCode = await this.provider.getCode(this.proxyAddress);
    if (proxyCode === '0x' || proxyCode.length < 10) {
      throw new Error(`No Safe contract found at ${this.proxyAddress}. Is this a valid Gnosis Safe proxy?`);
    }
    
    // Initialize Safe using v4 pattern (provider as RPC URL string)
    this.safe = await Safe.init({
      provider: process.env.RPC_URL!,  // Use RPC URL string directly
      signer: process.env.PRIVATE_KEY!,  // Use private key directly
      safeAddress: this.proxyAddress,
    });
    
    const owners = await this.safe.getOwners();
    const signerAddress = await this.signer.getAddress();
    
    if (!owners.includes(signerAddress)) {
      throw new Error(`Signer ${signerAddress} is not an owner of Safe ${this.proxyAddress}`);
    }
    
    // Check Safe threshold
    const threshold = await this.safe.getThreshold();
    console.log(`   Safe threshold: ${threshold}/${owners.length}`);
    
    console.log(`✅ Connected to ${isTestMode ? 'Mumbai Testnet' : 'Polygon Mainnet'}`);
    console.log(`✅ Safe initialized: ${this.proxyAddress}`);
    console.log(`✅ Signer: ${signerAddress}`);
    console.log(`✅ Contracts verified`);
  }
  
  async fetchRedeemablePositions(): Promise<Position[]> {
    console.log('🔍 Fetching redeemable positions...');
    
    // IMPORTANT: Positions are held in the proxy wallet, not the EOA
    const url = `${currentConfig.polymarketApi}/positions`;
    const limit = 100; // Items per page
    let offset = 0;
    const allPositions: Position[] = [];
    
    try {
      // Paginate through all positions using offset-based pagination
      while (true) {
        const response = await axios.get(url, {
          params: {
            user: this.proxyAddress.toLowerCase(),  // Use proxy address, not EOA!
            limit,
            offset,
          },
          headers: {
            'User-Agent': 'Polymarket-Auto-Claimer/1.0',
            'Accept': 'application/json',
          },
        });
        
        const positions = response.data as Position[];
        console.log(`📄 Fetched ${positions.length} positions (offset: ${offset})`);
        
        if (positions.length === 0) {
          break; // No more data
        }
        
        allPositions.push(...positions);
        
        if (positions.length < limit) {
          break; // Last page (partial)
        }
        
        offset += limit;
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      console.log(`📊 Total positions fetched: ${allPositions.length}`);
      
      // Filter for actually claimable positions
      // Only claim winning positions where curPrice = 1 and redeemable = true
      const claimable = allPositions.filter(pos => {
        // Must be marked as redeemable
        if (!pos.redeemable) return false;
        
        // Must have shares to redeem
        if (pos.size <= 0) return false;
        
        // Must be a winning position (curPrice = 1)
        // Losing positions (curPrice = 0) don't have USDC to claim
        if (pos.curPrice !== 1) {
          return false;
        }
        
        // Optional: Filter for recently resolved markets (last 48 hours)
        // Uncomment to enable date filtering:
        /*
        if (pos.endDate) {
          const endDate = new Date(pos.endDate);
          const now = new Date();
          const hoursAgo = (now.getTime() - endDate.getTime()) / (1000 * 60 * 60);
          
          // Skip very old resolved markets
          if (hoursAgo > 48) return false;
        }
        */
        
        return true;
      });
      
      // Log statistics
      const redeemableCount = allPositions.filter(p => p.redeemable).length;
      const winningCount = allPositions.filter(p => p.curPrice === 1).length;
      const losingCount = allPositions.filter(p => p.curPrice === 0).length;
      
      console.log(`📊 Found ${redeemableCount} positions marked redeemable`);
      console.log(`📊 Found ${winningCount} winning positions (curPrice = 1)`);
      console.log(`📊 Found ${losingCount} losing positions (curPrice = 0)`);
      console.log(`✅ Found ${claimable.length} claimable winning positions`);
      
      return claimable;
      
    } catch (error) {
      console.error('❌ Failed to fetch positions:', error);
      return [];
    }
  }
  
  buildRedemptionCalldata(conditionId: string, outcomeIndex: number): string {
    const indexSet = 1n << BigInt(outcomeIndex);
    
    const ctfInterface = new ethers.Interface([
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ]);
    
    return ctfInterface.encodeFunctionData('redeemPositions', [
      currentConfig.usdcAddress,
      ethers.ZeroHash,
      conditionId,
      [indexSet],
    ]);
  }

  /**
   * Batch claim multiple positions in a SINGLE Safe transaction.
   * This is how Polymarket does it - all claims in one TX, one nonce, one block.
   */
  async batchClaimPositions(positions: Position[], dryRun: boolean = false): Promise<{ success: boolean; txHash?: string; claimed: number; failed: number }> {
    if (!this.safe) throw new Error('Safe not initialized');
    
    if (positions.length === 0) {
      return { success: true, claimed: 0, failed: 0 };
    }

    console.log(`\n🎯 ${dryRun ? '[DRY RUN] Would batch claim' : 'Batch claiming'} ${positions.length} positions in ONE transaction`);
    
    // Log all positions being claimed
    let totalValue = 0;
    for (const pos of positions) {
      console.log(`   • ${pos.title} - ${pos.outcome} (${pos.size} shares)`);
      totalValue += pos.size;
    }
    console.log(`   💰 Total value: ${totalValue.toFixed(2)} USDC`);

    if (dryRun) {
      console.log(`\n   ✅ [DRY RUN] Would redeem ${positions.length} positions`);
      return { success: true, txHash: 'DRY_RUN', claimed: positions.length, failed: 0 };
    }

    try {
      // Build array of transaction calls - one for each position
      const transactions = positions.map(position => {
        const calldata = this.buildRedemptionCalldata(
          position.conditionId,
          position.outcomeIndex
        );
        return {
          to: currentConfig.ctfAddress,
          value: '0',
          data: calldata,
          operation: 0 as const, // Call
        };
      });

      console.log(`\n   📝 Creating batched Safe transaction with ${transactions.length} calls...`);

      // Log Safe state
      const nonce = await this.safe.getNonce();
      const threshold = await this.safe.getThreshold();
      console.log(`      - Safe nonce: ${nonce}`);
      console.log(`      - Threshold: ${threshold}/1`);

      // Create ONE Safe transaction with ALL redemption calls
      const safeTransaction = await this.safe.createTransaction({
        transactions,
      });

      const safeTxHash = await this.safe.getTransactionHash(safeTransaction);
      console.log(`      - Safe TX Hash: ${safeTxHash}`);
      console.log(`      - Batched calls: ${transactions.length}`);

      // Sign transaction
      console.log('\n   ✍️  Signing batched transaction...');
      let signedTx;
      try {
        signedTx = await this.safe.signTransaction(
          safeTransaction,
          'eth_signTypedData_v4' as any
        );
      } catch {
        signedTx = await this.safe.signTransaction(safeTransaction);
      }

      // Check signatures and add manually if needed
      const signatures = (signedTx as any).signatures;
      const signers = signatures ? Object.keys(signatures) : [];
      
      if (signers.length === 0) {
        console.log('      ⚠️  No signatures, adding manually...');
        try {
          const txHash = await this.safe.getTransactionHash(safeTransaction);
          const signature = await this.safe.signHash(txHash);
          (signedTx as any).addSignature(signature);
          console.log('      ✅ Manual signature added');
        } catch (e) {
          console.log('      ⚠️  Manual signing failed, proceeding anyway');
        }
      }

      // Execute the batched transaction with explicit gas options
      console.log('\n   🚀 Executing batched transaction...');
      
      // Get current gas prices from network
      const feeData = await this.provider.getFeeData();
      const signerAddress = await this.signer.getAddress();
      
      // Check for stuck pending transactions
      let currentNonce = await this.provider.getTransactionCount(signerAddress, 'latest');
      let pendingNonce = await this.provider.getTransactionCount(signerAddress, 'pending');
      
      console.log(`      - Signer: ${signerAddress}`);
      console.log(`      - Latest nonce: ${currentNonce}, Pending nonce: ${pendingNonce}`);
      
      // Cancel ALL stuck pending transactions (up to 10 per run to avoid timeout)
      const maxCancels = 10;
      let cancelled = 0;
      
      while (pendingNonce > currentNonce && cancelled < maxCancels) {
        const stuckCount = pendingNonce - currentNonce;
        console.log(`      ⚠️  ${stuckCount} stuck pending transactions detected!`);
        console.log(`      🔄 Cancelling stuck TX at nonce ${currentNonce}...`);
        
        try {
          // Send 0 value TX to self to cancel the stuck TX
          const cancelTx = await this.signer.sendTransaction({
            to: signerAddress,
            value: 0,
            nonce: currentNonce,
            maxFeePerGas: (feeData.maxFeePerGas || 50000000000n) * 2n, // 2x current gas
            maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas || 25000000000n) * 2n,
            gasLimit: 21000,
          });
          console.log(`      📤 Cancel TX sent: ${cancelTx.hash}`);
          const receipt = await cancelTx.wait();
          console.log(`      ✅ Cancelled! Block: ${receipt?.blockNumber}`);
          cancelled++;
          
          // Re-fetch nonces AFTER cancel
          currentNonce = await this.provider.getTransactionCount(signerAddress, 'latest');
          pendingNonce = await this.provider.getTransactionCount(signerAddress, 'pending');
          console.log(`      - New nonce: ${currentNonce}, Pending: ${pendingNonce}`);
        } catch (cancelError: any) {
          console.log(`      ❌ Cancel failed: ${cancelError.message}`);
          break; // Stop trying if cancel fails
        }
      }
      
      // If there are still pending TXs, skip Safe execution
      if (pendingNonce > currentNonce) {
        console.log(`      ⚠️  Still ${pendingNonce - currentNonce} pending TXs - will retry next run`);
        return { success: false, txHash: undefined, claimed: 0, failed: positions.length };
      }
      
      // Use network gas prices with 50% buffer (Polygon can spike fast)
      const maxGasPrice = 1000000000000n; // 1000 gwei max (safety cap only)
      const networkFee = feeData.maxFeePerGas || 50000000000n;
      const bufferedFee = (networkFee * 150n) / 100n; // 1.5x buffer
      const actualMaxFee = bufferedFee < maxGasPrice ? bufferedFee : maxGasPrice;
      
      console.log(`      - Gas prices: network=${Number(networkFee) / 1e9} gwei, using=${Number(actualMaxFee) / 1e9} gwei (1.5x)`);
      console.log(`      - Using nonce: ${currentNonce}`);
      
      const executionOptions = {
        from: signerAddress,
        gasLimit: '500000',
        maxFeePerGas: actualMaxFee.toString(),
        maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas || 25000000000n).toString(),
        nonce: currentNonce, // Use latest confirmed nonce (updated after cancel)
      };
      
      const executeTxResponse = await this.safe.executeTransaction(signedTx, executionOptions);
      
      // Debug: log full response structure
      const response = executeTxResponse as any;
      console.log(`      - Response type: ${typeof response}`);
      console.log(`      - Response keys: ${Object.keys(response || {}).join(', ')}`);
      
      // The Safe SDK returns { hash, transactionResponse } 
      // transactionResponse is the actual ethers TransactionResponse
      const txResponse = response.transactionResponse;
      console.log(`      - transactionResponse type: ${typeof txResponse}`);
      console.log(`      - transactionResponse keys: ${Object.keys(txResponse || {}).join(', ')}`);
      if (txResponse) {
        console.log(`      - txResponse.hash: ${txResponse.hash}`);
        console.log(`      - txResponse.nonce: ${txResponse.nonce}`);
        console.log(`      - txResponse.from: ${txResponse.from}`);
        console.log(`      - txResponse.to: ${txResponse.to}`);
      }
      const txHash = txResponse?.hash || response.hash;
      
      if (!txHash) {
        console.log('   ❌ No transaction hash returned');
        console.log(`      - Full response: ${JSON.stringify(response, null, 2).slice(0, 500)}`);
        return { success: false, claimed: 0, failed: positions.length };
      }

      console.log(`   ✅ Batch TX submitted: ${txHash}`);
      
      // Use the transactionResponse.wait() method if available - this is more reliable
      if (txResponse && typeof txResponse.wait === 'function') {
        console.log(`   ⏳ Waiting for confirmation via txResponse.wait()...`);
        try {
          const receipt = await txResponse.wait(1); // Wait for 1 confirmation
          if (receipt && receipt.status === 1) {
            console.log(`   ✅ Batch confirmed! All ${positions.length} positions claimed`);
            console.log(`   🔗 https://polygonscan.com/tx/${txHash}`);
            return { success: true, txHash, claimed: positions.length, failed: 0 };
          } else {
            console.log(`   ❌ Batch transaction reverted (status: ${receipt?.status})`);
            return { success: false, txHash, claimed: 0, failed: positions.length };
          }
        } catch (waitError: any) {
          console.log(`   ⚠️  Wait error: ${waitError.message}`);
          // Transaction might still be pending
        }
      } else {
        console.log(`   ⚠️  No wait() method on response, using provider.waitForTransaction`);
        console.log(`   ⏳ Waiting for confirmation...`);
        
        try {
          const confirmationTimeout = 90000; // 90 seconds
          const receipt = await Promise.race([
            this.provider.waitForTransaction(txHash, 1),
            new Promise<null>((_, reject) => 
              setTimeout(() => reject(new Error('Confirmation timeout')), confirmationTimeout)
            )
          ]);

          if (receipt && receipt.status === 1) {
            console.log(`   ✅ Batch confirmed! All ${positions.length} positions claimed`);
            console.log(`   🔗 https://polygonscan.com/tx/${txHash}`);
            return { success: true, txHash, claimed: positions.length, failed: 0 };
          } else if (receipt && receipt.status === 0) {
            console.log(`   ❌ Batch transaction reverted on-chain`);
            return { success: false, txHash, claimed: 0, failed: positions.length };
          }
        } catch (e: any) {
          if (e.message === 'Confirmation timeout') {
            console.log(`   ⚠️  Confirmation timeout - checking if TX exists...`);
            // Check if transaction actually exists
            const txReceipt = await this.provider.getTransactionReceipt(txHash);
            if (txReceipt) {
              console.log(`   ✅ TX found on chain! Status: ${txReceipt.status}`);
              return { success: txReceipt.status === 1, txHash, claimed: txReceipt.status === 1 ? positions.length : 0, failed: txReceipt.status === 1 ? 0 : positions.length };
            } else {
              console.log(`   ❌ TX not found on chain - broadcast may have failed`);
              return { success: false, claimed: 0, failed: positions.length };
            }
          }
          console.log(`   ⚠️  Confirmation error: ${e.message}`);
        }
      }

      return { success: false, claimed: 0, failed: positions.length };

    } catch (error: any) {
      console.log(`\n   ❌ Batch claim failed: ${error.message}`);
      
      // If batch fails, suggest retry
      if (positions.length > 1) {
        console.log(`   ℹ️  Try with smaller batch size on next run`);
      }
      
      return { success: false, claimed: 0, failed: positions.length };
    }
  }
  
  async claimPosition(position: Position, dryRun: boolean = false) {
    if (!this.safe) throw new Error('Safe not initialized');
    
    console.log(`\n💰 ${dryRun ? '[DRY RUN] Would claim' : 'Claiming'} position in market: ${position.title}`);
    console.log(`   Outcome: ${position.outcome}`);
    console.log(`   Size: ${position.size} shares`);
    console.log(`   Condition ID: ${position.conditionId}`);
    console.log(`   Outcome Index: ${position.outcomeIndex}`);
    
    // If dry run, just show what would happen without executing
    if (dryRun) {
      console.log(`   ✅ [DRY RUN] Would redeem position with:`);
      console.log(`      - Expected payout: ${position.size} USDC`);
      return { success: true, txHash: 'DRY_RUN' };
    }
    
    try {
      // Log Safe state before transaction
      console.log('\n   🔍 Safe State:');
      const nonce = await this.safe.getNonce();
      const owners = await this.safe.getOwners();
      const threshold = await this.safe.getThreshold();
      console.log(`      - Nonce: ${nonce}`);
      console.log(`      - Threshold: ${threshold}/${owners.length}`);
      console.log(`      - Owners: ${owners.join(', ')}`);
      
      // Build transaction data
      const calldata = this.buildRedemptionCalldata(
        position.conditionId,
        position.outcomeIndex
      );
      console.log(`      - Calldata: ${calldata.slice(0, 50)}...`);
      
      // Create Safe transaction
      console.log('\n   📝 Creating Safe transaction...');
      const safeTransaction = await this.safe.createTransaction({
        transactions: [{
          to: currentConfig.ctfAddress,
          value: '0',
          data: calldata,
          operation: 0, // Call
        }],
      });
      
      // Log transaction details
      console.log('   📋 Transaction details:');
      console.log(`      - To: ${currentConfig.ctfAddress}`);
      console.log(`      - Safe TX Hash: ${await this.safe.getTransactionHash(safeTransaction)}`);
      console.log(`      - Nonce: ${safeTransaction.data.nonce}`);
      
      // Sign transaction - Try multiple methods to ensure signature is added
      console.log('\n   ✍️  Signing transaction...');
      
      // Try signing with explicit method first
      let signedTx;
      try {
        // Try eth_signTypedData_v4 first (recommended for Safe)
        signedTx = await this.safe.signTransaction(
          safeTransaction,
          'eth_signTypedData_v4' as any
        );
        console.log('      - Used signing method: eth_signTypedData_v4');
      } catch (e1) {
        console.log('      - eth_signTypedData_v4 failed, trying eth_sign...');
        try {
          // Fallback to eth_sign
          signedTx = await this.safe.signTransaction(
            safeTransaction,
            'eth_sign' as any
          );
          console.log('      - Used signing method: eth_sign');
        } catch (e2) {
          console.log('      - Both signing methods failed, using default...');
          signedTx = await this.safe.signTransaction(safeTransaction);
          console.log('      - Used signing method: default');
        }
      }
      
      // Check if signatures were added
      const signatures = (signedTx as any).signatures;
      const signers = signatures ? Object.keys(signatures) : [];
      
      console.log('   🔍 Signature check:');
      console.log(`      - Signatures found: ${signers.length}`);
      
      // If no signatures, try manual signing as fallback
      if (signers.length === 0) {
        console.log('      ⚠️  No signatures in transaction, attempting manual signing...');
        
        try {
          // Get transaction hash and sign it manually
          const txHash = await this.safe.getTransactionHash(safeTransaction);
          console.log(`      - Transaction hash: ${txHash}`);
          
          // Sign the hash and get the signature
          const signature = await this.safe.signHash(txHash);
          console.log(`      - Manual signature created`);
          
          // Explicitly add the signature to the transaction
          // This is crucial for Safe SDK v4
          (signedTx as any).addSignature(signature);
          
          const signerAddress = await this.signer.getAddress();
          console.log(`      - Signature added for: ${signerAddress}`);
          console.log('      ✅ Fallback signing successful');
          
          // Verify signature was added
          const updatedSigners = (signedTx as any).signatures ? 
            Array.from((signedTx as any).signatures.keys()) : [];
          console.log(`      - Signatures after fallback: ${updatedSigners.length}`);
          
        } catch (fallbackError) {
          console.error('      ❌ Fallback signing failed:', fallbackError);
          console.log('      ⚠️  Proceeding anyway - Safe SDK might handle it internally');
        }
      } else {
        console.log(`      ✅ Signatures present from: ${signers.join(', ')}`);
      }
      
      // Execute transaction with explicit gas options
      console.log('\n   🚀 Executing transaction...');
      try {
        // Get current gas prices from network
        const feeData = await this.provider.getFeeData();
        const signerAddress = await this.signer.getAddress();
        const latestNonce = await this.provider.getTransactionCount(signerAddress, 'latest');
        
        // Use network gas prices with 50% buffer (Polygon can spike fast)
        const maxGasPrice = 1000000000000n; // 1000 gwei max (safety cap only)
        const networkFee = feeData.maxFeePerGas || 50000000000n;
        const bufferedFee = (networkFee * 150n) / 100n; // 1.5x buffer
        const actualMaxFee = bufferedFee < maxGasPrice ? bufferedFee : maxGasPrice;
        
        console.log(`      - Signer: ${signerAddress}, nonce: ${latestNonce}`);
        console.log(`      - Gas: network=${Number(networkFee) / 1e9} gwei, using=${Number(actualMaxFee) / 1e9} gwei (1.5x)`);
        
        const executionOptions = {
          from: signerAddress,
          gasLimit: '300000',
          maxFeePerGas: actualMaxFee.toString(),
          maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas || 25000000000n).toString(),
          nonce: latestNonce,
        };
        
        const executeTxResponse = await this.safe.executeTransaction(signedTx, executionOptions);
        
        // Log full response for debugging
        console.log('   📦 Execution response received');
        console.log(`      - Response keys: ${Object.keys(executeTxResponse as any).join(', ')}`);
        
        // In Safe SDK v4, the response structure is different
        // The actual on-chain transaction hash should be in 'hash' or from the transactionResponse
        const response = executeTxResponse as any;
        
        // Try to get the actual blockchain transaction hash
        let txHash: string | null = null;
        
        if (response.hash) {
          txHash = response.hash;
          console.log(`      - Found hash: ${txHash}`);
        }
        if (response.transactionResponse?.hash) {
          txHash = response.transactionResponse.hash;
          console.log(`      - Found transactionResponse.hash: ${txHash}`);
        }
        if (!txHash && response.safeTxHash) {
          console.log(`      ⚠️  Only safeTxHash found (not a blockchain tx): ${response.safeTxHash}`);
        }
        
        if (txHash) {
          console.log(`   ✅ TX submitted: ${txHash}`);
          
          // MUST wait for confirmation before proceeding to next claim
          // Otherwise all claims use the same nonce and only one can succeed
          try {
            const confirmationTimeout = 90000; // 90 seconds - Polygon can be slow
            console.log(`   ⏳ Waiting for confirmation (up to 90s)...`);
            const receipt = await Promise.race([
              this.provider.waitForTransaction(txHash, 1),
              new Promise<null>((_, reject) => 
                setTimeout(() => reject(new Error('Confirmation timeout')), confirmationTimeout)
              )
            ]);
            if (receipt) {
              console.log(`   ✅ Confirmed on chain (status: ${receipt.status})`);
              if (receipt.status === 0) {
                console.log(`   ❌ Transaction reverted on-chain!`);
                return { success: false, error: 'Transaction reverted' };
              }
              return { success: true, txHash };
            }
          } catch (e: any) {
            if (e.message === 'Confirmation timeout') {
              console.log(`   ⚠️  Confirmation timeout - stopping to avoid nonce issues`);
              console.log(`   ℹ️  TX may still confirm later. Check: https://polygonscan.com/tx/${txHash}`);
              // Return failure to stop processing more claims with potentially stale nonce
              return { success: false, error: 'Confirmation timeout - nonce may be stale' };
            } else {
              console.log(`   ⚠️  Could not verify transaction: ${e.message}`);
              return { success: false, error: `Verification failed: ${e.message}` };
            }
          }
          
          return { success: true, txHash };
        } else {
          console.log('   ❌ No blockchain transaction hash returned!');
          console.log(`      - Full response: ${JSON.stringify(response, null, 2).slice(0, 500)}`);
          return { success: false, error: 'No transaction hash returned' };
        }
      } catch (execError: any) {
        console.log('\n   ❌ Execution failed');
        
        // Decode error if it's a Safe error
        if (execError.data) {
          try {
            // Try to decode GS error
            const errorData = execError.data;
            if (typeof errorData === 'string' && errorData.startsWith('0x08c379a0')) {
              // This is a revert string
              const reason = ethers.AbiCoder.defaultAbiCoder().decode(
                ['string'],
                '0x' + errorData.slice(10)
              )[0];
              console.log(`      - Decoded error: ${reason}`);
              
              // Check for specific GS errors
              if (reason.includes('GS026')) {
                console.log('      - GS026: Invalid owner provided');
                console.log('      - This usually means the signature is invalid or from wrong owner');
              } else if (reason.includes('GS013')) {
                console.log('      - GS013: Safe transaction already executed');
              }
            }
          } catch {
            console.log(`      - Raw error data: ${execError.data}`);
          }
        }
        
        // Handle relayer-specific errors
        if (execError.message?.includes('already executed') || 
            execError.message?.includes('nonce')) {
          console.log('   ⚠️  Transaction may have been already executed');
          return { success: true, txHash: null };
        }
        throw execError;
      }
      
    } catch (error: any) {
      const errorMsg = error.reason || error.message || 'Unknown error';
      console.error(`   ❌ Failed to claim: ${errorMsg}`);
      
      // Log more details for debugging
      if (error.code) console.error(`      - Error code: ${error.code}`);
      if (error.data) console.error(`      - Error data: ${error.data}`);
      if (error.transaction) {
        console.error(`      - Transaction to: ${error.transaction.to}`);
        console.error(`      - Transaction data: ${error.transaction.data?.slice(0, 50)}...`);
      }
      
      return { success: false, error: errorMsg };
    }
  }
  
  async run(dryRun: boolean = false) {
    try {
      await this.initialize();
      
      const positions = await this.fetchRedeemablePositions();
      
      if (positions.length === 0) {
        console.log('\n✨ No positions to claim');
        return;
      }
      
      const totalValue = positions.reduce((sum, pos) => sum + pos.size, 0);
      
      if (dryRun) {
        console.log(`\n🔍 DRY RUN MODE - Found ${positions.length} claimable positions:`);
        console.log('=' .repeat(60));
        console.log(`\n📊 Total claimable value: ${totalValue.toFixed(2)} USDC`);
      } else {
        console.log(`\n🚀 Batch claiming ${positions.length} positions (${totalValue.toFixed(2)} USDC)...`);
      }
      
      // Batch claims into groups of 10 (like Polymarket does)
      const BATCH_SIZE = 10;
      let totalClaimed = 0;
      let totalFailed = 0;
      
      // Process all positions in batches
      for (let i = 0; i < positions.length; i += BATCH_SIZE) {
        const batch = positions.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(positions.length / BATCH_SIZE);
        
        if (totalBatches > 1) {
          console.log(`\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} positions)`);
        }
        
        const result = await this.batchClaimPositions(batch, dryRun);
        totalClaimed += result.claimed;
        totalFailed += result.failed;
        
        // If batch failed, stop processing more batches
        if (!result.success && !dryRun) {
          console.log(`\n   ⚠️  Batch failed - stopping. Will retry remaining in next run.`);
          break;
        }
        
        // Small delay between batches (if more than one)
        if (!dryRun && i + BATCH_SIZE < positions.length) {
          console.log('   ⏳ Waiting 3s before next batch...');
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      console.log('\n📈 Summary:');
      if (dryRun) {
        console.log(`   🔍 [DRY RUN] Would claim: ${positions.length} positions`);
        console.log(`   💰 Total value: ${totalValue.toFixed(2)} USDC`);
      } else {
        console.log(`   ✅ Claimed: ${totalClaimed}`);
        console.log(`   ❌ Failed: ${totalFailed}`);
        console.log(`   📊 Total: ${positions.length}`);
      }
      
    } catch (error) {
      console.error('\n🚨 Fatal error:', error);
      process.exit(1);
    }
  }
  
  async getBalances() {
    const usdcInterface = new ethers.Interface([
      'function balanceOf(address) view returns (uint256)',
    ]);
    
    const usdcContract = new ethers.Contract(
      currentConfig.usdcAddress,
      usdcInterface,
      this.provider
    );
    
    // Get USDC balance in Safe
    const balance = await usdcContract.balanceOf(this.proxyAddress);
    const formattedBalance = ethers.formatUnits(balance, 6);
    
    // Get MATIC balance in MetaMask/EOA (pays for gas)
    const signerAddress = await this.signer.getAddress();
    const eoaMaticBalance = await this.provider.getBalance(signerAddress);
    const formattedEoaMatic = ethers.formatEther(eoaMaticBalance);
    
    // Get MATIC balance in Safe (informational only)
    const safeMaticBalance = await this.provider.getBalance(this.proxyAddress);
    const formattedSafeMatic = ethers.formatEther(safeMaticBalance);
    
    console.log(`\n💰 Wallet Balances:`);
    console.log(`   📱 MetaMask/EOA (${signerAddress.slice(0, 6)}...${signerAddress.slice(-4)}):`);
    console.log(`      ⛽ MATIC: ${formattedEoaMatic} (pays gas fees)`);
    console.log(`   🔐 Safe (${this.proxyAddress.slice(0, 6)}...${this.proxyAddress.slice(-4)}):`);
    console.log(`      💵 USDC: ${formattedBalance}`);
    console.log(`      ⛽ MATIC: ${formattedSafeMatic} (not needed for claims)`);
  }
}

// Main execution
async function main() {
  // Set a hard timeout of 2 minutes to prevent hanging
  const PROCESS_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
  const timeoutId = setTimeout(() => {
    console.error('⏰ Process timeout reached (2 minutes) - forcing exit');
    process.exit(1);
  }, PROCESS_TIMEOUT_MS);
  // Don't let the timeout keep the process alive if we finish early
  timeoutId.unref();
  
  console.log('🎯 Polymarket Auto-Claimer');
  
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE ENABLED');
  }
  
  console.log('=' .repeat(40));
  
  const claimer = new SimplePolymarketClaimer();
  
  // Check balances first
  await claimer.getBalances();
  
  // Run the claimer with dry run flag
  await claimer.run(isDryRun);
  
  // Check balances after (skip in dry run since nothing changed)
  if (!isDryRun) {
    await claimer.getBalances();
  }
  
  // Explicitly exit to ensure process terminates (closes RPC connections, etc.)
  console.log('✅ Done - exiting');
  process.exit(0);
}

// Handle direct execution
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default SimplePolymarketClaimer;
export { SimplePolymarketClaimer, Position };