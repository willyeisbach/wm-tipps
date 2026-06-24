import { CryptoHelper } from './crypto-helper.js';

/**
 * Default consensus parameters. The founder can override these from index.html
 * via `app.config` before the first sync (e.g. set bootstrapAdmins).
 */
export const DEFAULT_CONFIG = {
  // Share of the peers registered BEFORE a candidate that must approve its
  // REGISTER_NAME. Threshold is fixed per registration (order-independent).
  registrationApprovalRatio: 0.75,
  // Auto-witnesses required for a TRADE / INITIALIZE_PLAYER to commit. Capped at
  // the number of eligible (committed, non-party) peers so small groups don't stall.
  tradeWitnesses: 3,
  initWitnesses: 3,
  // Optional allow-list of base64 public keys permitted to become genesis admins
  // (auto-committed without approval). If empty, the first REGISTER_NAME by
  // timestamp is treated as genesis (less secure – see integrityWarnings).
  bootstrapAdmins: [],
  // Starting allocation for every player.
  startEUR: 10.00,
  startShares: 100,
  // Initial quoted price per share before any trade has happened (EUR/Stück).
  // Used as the chart's starting point for every Kollegen-AG.
  initialSharePrice: 0.05,
  // Final settlement: the real-money tip-pool to be paid out. Hard-coded for our
  // pool of 5 € stake × 15 tip participants = 75 €. (Independent from the number
  // of share-trading participants.)
  payoutPool: 75.00,
  // Real-money share for tip ranks 1/2/3 (must sum to 1.0). Place 1 = 50 %,
  // Place 2 = 30 %, Place 3 = 20 %. The prize of each ranked "Ich-AG" is split
  // among its shareholders (100 shares per AG → prize/100 € per share).
  payoutRankShares: [0.50, 0.30, 0.20]
};

export class TippspielApp {
  constructor() {
    this.dirHandle = null;
    this.myKeys = null; // { publicKey, privateKey, pubKeyBase64 }
    this.myName = "";
    this.config = { ...DEFAULT_CONFIG };

    // Players whose INITIALIZE_PLAYER has already been applied (anti re-init reset).
    this.initializedPlayers = new Set();

    // Integrity / anti-tamper state.
    this.integrityWarnings = [];
    this.onIntegrityWarning = () => {};
    this.ledgerFingerprint = ""; // short hash over all committed tx hashes
    
    // InMemory State Reconstructed from Ledger Files
    this.transactions = []; // List of all valid committed transactions
    this.signatures = {};   // txHash -> Set of witness pubKeys
    this.balances = {};     // pubKey -> { EUR: number, SHARES: { [pubKey]: number } }
    this.names = {};        // pubKey -> string (alias)
    
    // Orderbook states
    this.activeOrders = {};  // orderHash -> order object
    this.spentOrders = new Set(); // orderHashes that have been executed
    this.spentOrderBy = {};  // orderHash -> winning TRADE hash (for race detection)

    this.mempoolTransactions = []; // Unconfirmed txs (REGISTER_NAME, INITIALIZE_PLAYER, TRADE)
    this.onStateChanged = () => {}; // UI callback

    // Notifies the UI when one of OUR own TRADEs lost a race for an order that
    // another buyer's trade already consumed (no funds were moved on our side).
    this.onTradeRejected = () => {};
    this._notifiedRejected = new Set(); // own trade hashes already reported (anti-spam)

    // Registration status of our own key (drives the UI: register / pending /
    // "name already taken" error) and prevents re-publishing duplicates.
    this.myRegistrationExists = false;   // any REGISTER_NAME from our key seen in folder
    this.myRegistrationRejected = false; // our chosen name is already owned by another key
    this.myRegistrationDeclined = false; // enough peers rejected us -> can't get in
    this.rejectVotes = {};               // regTxHash -> Set of voter pubKeys
    this.rejectedRegHashes = new Set();  // REGISTER_NAME tx hashes that were rejected

    // syncLedger reentrancy guard (auto-sync timer + user actions).
    this._syncing = false;
    this._syncPending = false;
  }

  /**
   * Initializes the user's wallet. Generates or loads keys from LocalStorage.
   */
  async initWallet() {
    const storedKeys = localStorage.getItem('tippspiel_wallet_keys');
    const storedName = localStorage.getItem('tippspiel_username');
    
    if (storedKeys) {
      try {
        const parsed = JSON.parse(storedKeys);
        const privateKey = await CryptoHelper.importPrivateKey(parsed.private);
        const publicKey = await CryptoHelper.importPublicKey(parsed.public);
        this.myKeys = {
          publicKey,
          privateKey,
          pubKeyBase64: parsed.public
        };
      } catch (e) {
        console.error("Wallet loading failed, generating new key pair", e);
        await this._generateNewWallet();
      }
    } else {
      await this._generateNewWallet();
    }

    this.myName = storedName || "";
  }

  async _generateNewWallet() {
    const keys = await CryptoHelper.generateKeyPair();
    const pubBase64 = await CryptoHelper.exportPublicKey(keys.publicKey);
    const privBase64 = await CryptoHelper.exportPrivateKey(keys.privateKey);
    
    this.myKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      pubKeyBase64: pubBase64
    };

    localStorage.setItem('tippspiel_wallet_keys', JSON.stringify({
      public: pubBase64,
      private: privBase64
    }));
  }

  async setUsername(name) {
    this.myName = name;
    localStorage.setItem('tippspiel_username', name);
    
    if (this.dirHandle) {
      // Broadcast name registration into Mempool
      await this.publishTransaction({
        type: "REGISTER_NAME",
        name: name
      });
    }
  }

  /**
   * Forgets our locally chosen name (e.g. after it was rejected as already taken),
   * so the user can pick a different one. Keeps the wallet/keys intact.
   */
  clearUsername() {
    this.myName = "";
    localStorage.removeItem('tippspiel_username');
    this.myRegistrationRejected = false;
    this.myRegistrationDeclined = false;
  }

  /**
   * Binds the local SharePoint sync folder.
   */
  async selectSyncFolder(handle = null) {
    if (handle) {
      this.dirHandle = handle;
    } else {
      this.dirHandle = await window.showDirectoryPicker();
    }
    
    // Ensure folder structure exists
    await this.dirHandle.getDirectoryHandle('mempool', { create: true });
    await this.dirHandle.getDirectoryHandle('signatures', { create: true });
    
    // Initial sync
    await this.syncLedger();
  }

  /**
   * Publishes a new transaction to the mempool
   */
  async publishTransaction(payload) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    const tx = {
      ...payload,
      senderPubKey: this.myKeys.pubKeyBase64,
      timestamp: Date.now(),
      prevHash: this.transactions.length > 0 ? this.transactions[this.transactions.length - 1].hash : "0".repeat(64)
    };

    // Sign the transaction
    const signature = await CryptoHelper.signData(this.myKeys.privateKey, tx);
    tx.signature = signature;

    const txHash = await CryptoHelper.hashData(tx);
    tx.hash = txHash;

    // Write file to /mempool/
    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');
    const fileHandle = await mempoolDir.getFileHandle(`tx_${txHash}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(tx, null, 2));
    await writable.close();

    // Re-sync to include local action immediately
    await this.syncLedger();
  }

  /**
   * Publishes an open SELL_ORDER onto the marketplace
   */
  async publishSellOrder(asset, amount, pricePerUnit) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    // Input validation: shares are whole pieces, price must be a finite, non-negative number.
    if (typeof asset !== "string" || !asset.startsWith("SHARE_")) {
      throw new Error("Ungültiges Asset.");
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Menge muss eine positive ganze Zahl sein.");
    }
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      throw new Error("Preis muss eine endliche, nicht-negative Zahl sein.");
    }

    const order = {
      type: "SELL_ORDER",
      seller: this.myKeys.pubKeyBase64,
      asset,
      amount,
      pricePerUnit,
      timestamp: Date.now()
    };

    // Sign the order details
    const signature = await CryptoHelper.signData(this.myKeys.privateKey, {
      type: order.type,
      seller: order.seller,
      asset: order.asset,
      amount: order.amount,
      pricePerUnit: order.pricePerUnit,
      timestamp: order.timestamp
    });
    order.signature = signature;

    const orderHash = await CryptoHelper.hashData(order);
    order.hash = orderHash;

    // Write file as order_[hash].json into /mempool/
    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');
    const fileHandle = await mempoolDir.getFileHandle(`order_${orderHash}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(order, null, 2));
    await writable.close();

    await this.syncLedger();
  }

  /**
   * Executes an open sell order from another user.
   * Creates a TRADE transaction and automatically deletes the original order file.
   */
  async executeOrder(order) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    if (!order || !Number.isInteger(order.amount) || order.amount <= 0 ||
        !Number.isFinite(order.pricePerUnit) || order.pricePerUnit < 0) {
      throw new Error("Ungültiges Angebot.");
    }
    if (order.seller === this.myKeys.pubKeyBase64) {
      throw new Error("Eigene Angebote können nicht gekauft werden.");
    }

    const totalAmount = order.amount * order.pricePerUnit;

    const trade = {
      type: "TRADE",
      orderType: "SELL_ORDER",   // the order being executed was a sell order
      partyA: order.seller,      // Seller
      partyB: this.myKeys.pubKeyBase64, // Buyer
      giveAsset: order.asset,
      giveAmount: order.amount,
      receiveAsset: "EUR",
      receiveAmount: totalAmount,
      orderHash: order.hash,
      orderTimestamp: order.timestamp,
      pricePerUnit: order.pricePerUnit,
      timestamp: Date.now(),
      prevHash: this.transactions.length > 0 ? this.transactions[this.transactions.length - 1].hash : "0".repeat(64),
      senderPubKey: this.myKeys.pubKeyBase64
    };

    // Buyer signs their execution of this order
    const buyerSig = await CryptoHelper.signData(this.myKeys.privateKey, {
      type: "BUY_EXECUTION",
      buyer: trade.partyB,
      orderHash: trade.orderHash,
      timestamp: trade.timestamp
    });

    trade.signatures = {
      partyA: order.signature, // Reused from seller's order!
      partyB: buyerSig
    };

    // Sign transaction envelope over the full trade object (matching syncLedger
    // verification, which checks tx.signature against the trade minus signature/hash).
    trade.signature = await CryptoHelper.signData(this.myKeys.privateKey, trade);
    const txHash = await CryptoHelper.hashData(trade);
    trade.hash = txHash;

    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');

    // 1. Write TRADE to mempool
    const fileHandle = await mempoolDir.getFileHandle(`tx_${txHash}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(trade, null, 2));
    await writable.close();

    // 2. Delete the original order file from mempool
    try {
      await mempoolDir.removeEntry(`order_${order.hash}.json`);
    } catch (e) {
      console.warn("Could not delete local order file (might be deleted by OneDrive sync already):", e);
    }

    await this.syncLedger();
  }

  /**
   * Withdraws an own open SELL_ORDER from the marketplace by deleting its file.
   * Orders are not part of the integrity mirror, so a withdrawal is not "healed"
   * back. Only the seller may withdraw their own order.
   */
  async cancelSellOrder(orderHash) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    const order = this.activeOrders[orderHash];
    if (!order) throw new Error("Angebot nicht (mehr) vorhanden.");
    if (order.seller !== this.myKeys.pubKeyBase64) {
      throw new Error("Nur eigene Angebote können zurückgezogen werden.");
    }

    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');
    try {
      await mempoolDir.removeEntry(`order_${orderHash}.json`);
    } catch (e) {
      console.warn("Order-Datei konnte nicht gelöscht werden (evtl. bereits weg):", e);
    }

    await this.syncLedger();
  }

  /**
   * Publishes an open BUY_ORDER onto the marketplace.
   * Analogous to publishSellOrder, but expresses demand: the publisher (buyer)
   * offers EUR for a given share. A holder of that share can later sell into it.
   */
  async publishBuyOrder(asset, amount, pricePerUnit) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    // Input validation: shares are whole pieces, price must be a finite, non-negative number.
    if (typeof asset !== "string" || !asset.startsWith("SHARE_")) {
      throw new Error("Ungültiges Asset.");
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Menge muss eine positive ganze Zahl sein.");
    }
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      throw new Error("Preis muss eine endliche, nicht-negative Zahl sein.");
    }

    const order = {
      type: "BUY_ORDER",
      buyer: this.myKeys.pubKeyBase64,
      asset,
      amount,
      pricePerUnit,
      timestamp: Date.now()
    };

    // Sign the order details
    const signature = await CryptoHelper.signData(this.myKeys.privateKey, {
      type: order.type,
      buyer: order.buyer,
      asset: order.asset,
      amount: order.amount,
      pricePerUnit: order.pricePerUnit,
      timestamp: order.timestamp
    });
    order.signature = signature;

    const orderHash = await CryptoHelper.hashData(order);
    order.hash = orderHash;

    // Write file as order_[hash].json into /mempool/
    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');
    const fileHandle = await mempoolDir.getFileHandle(`order_${orderHash}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(order, null, 2));
    await writable.close();

    await this.syncLedger();
  }

  /**
   * Executes an open BUY_ORDER from another user. The caller acts as the SELLER,
   * delivering shares into the buyer's open demand. Creates a TRADE transaction
   * and automatically deletes the original order file. Mirror of executeOrder().
   */
  async executeBuyOrder(order) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    if (!order || !Number.isInteger(order.amount) || order.amount <= 0 ||
        !Number.isFinite(order.pricePerUnit) || order.pricePerUnit < 0) {
      throw new Error("Ungültiges Gesuch.");
    }
    if (order.buyer === this.myKeys.pubKeyBase64) {
      throw new Error("Eigene Kaufgesuche können nicht bedient werden.");
    }

    const totalAmount = order.amount * order.pricePerUnit;

    const trade = {
      type: "TRADE",
      orderType: "BUY_ORDER",            // the order being executed was a buy order
      partyA: this.myKeys.pubKeyBase64,  // Seller (the executor)
      partyB: order.buyer,               // Buyer (the order publisher)
      giveAsset: order.asset,
      giveAmount: order.amount,
      receiveAsset: "EUR",
      receiveAmount: totalAmount,
      orderHash: order.hash,
      orderTimestamp: order.timestamp,
      pricePerUnit: order.pricePerUnit,
      timestamp: Date.now(),
      prevHash: this.transactions.length > 0 ? this.transactions[this.transactions.length - 1].hash : "0".repeat(64),
      senderPubKey: this.myKeys.pubKeyBase64
    };

    // Seller signs their execution of this buy order.
    const sellerSig = await CryptoHelper.signData(this.myKeys.privateKey, {
      type: "SELL_EXECUTION",
      seller: trade.partyA,
      orderHash: trade.orderHash,
      timestamp: trade.timestamp
    });

    trade.signatures = {
      partyA: sellerSig,
      partyB: order.signature // Reused from buyer's BUY_ORDER!
    };

    // Sign transaction envelope over the full trade object.
    trade.signature = await CryptoHelper.signData(this.myKeys.privateKey, trade);
    const txHash = await CryptoHelper.hashData(trade);
    trade.hash = txHash;

    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');

    // 1. Write TRADE to mempool
    const fileHandle = await mempoolDir.getFileHandle(`tx_${txHash}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(trade, null, 2));
    await writable.close();

    // 2. Delete the original order file from mempool
    try {
      await mempoolDir.removeEntry(`order_${order.hash}.json`);
    } catch (e) {
      console.warn("Could not delete local order file (might be deleted by OneDrive sync already):", e);
    }

    await this.syncLedger();
  }

  /**
   * Withdraws an own open BUY_ORDER from the marketplace by deleting its file.
   * Only the buyer who published it may withdraw it. Mirror of cancelSellOrder().
   */
  async cancelBuyOrder(orderHash) {
    if (!this.dirHandle) throw new Error("Kein Sync-Ordner ausgewählt.");
    if (!this.myKeys) throw new Error("Wallet nicht initialisiert.");

    const order = this.activeOrders[orderHash];
    if (!order) throw new Error("Gesuch nicht (mehr) vorhanden.");
    if (order.buyer !== this.myKeys.pubKeyBase64) {
      throw new Error("Nur eigene Kaufgesuche können zurückgezogen werden.");
    }

    const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');
    try {
      await mempoolDir.removeEntry(`order_${orderHash}.json`);
    } catch (e) {
      console.warn("Order-Datei konnte nicht gelöscht werden (evtl. bereits weg):", e);
    }

    await this.syncLedger();
  }

  /**
   * Signs a manual registration approval request.
   */
  async approveRegistration(txHash) {
    if (!this.dirHandle || !this.myKeys) return;
    
    // Sign the registration tx hash
    const signature = await CryptoHelper.signData(this.myKeys.privateKey, txHash);
    
    const sigObj = {
      txHash: txHash,
      witnessPubKey: this.myKeys.pubKeyBase64,
      signature: signature
    };

    const signaturesDir = await this.dirHandle.getDirectoryHandle('signatures');
    // Unique, filename-safe witness id (all P-256 SPKI keys share the same base64
    // prefix, so substring() collides -> hash the key instead).
    const wid = (await CryptoHelper.hashData(this.myKeys.pubKeyBase64)).substring(0, 16);
    const fileHandle = await signaturesDir.getFileHandle(`sig_${txHash}_${wid}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(sigObj, null, 2));
    await writable.close();

    await this.syncLedger();
  }

  /**
   * Cast a reject vote against a pending registration. Any committed peer may
   * vote (egalitarian / decentralized). A reject vote does NOT block on its own:
   * the candidate is still admitted if they reach the approval threshold. Only
   * when so many peers reject that the threshold becomes unreachable is the
   * registration finally rejected (so the candidate gets feedback).
   */
  async rejectRegistration(targetHash) {
    if (!this.dirHandle || !this.myKeys) return;
    await this.publishTransaction({ type: "REJECT_REGISTRATION", targetHash });
  }

  /**
   * Reads all files from sync folder, validates signatures, reconstructs
   * state balances & active orders, and executes background witness checks.
   *
   * Overlap-safe wrapper: concurrent callers (the auto-sync timer plus
   * user-triggered actions) never run the reconstruction twice in parallel.
   * If a call arrives while a sync is in progress, exactly one more sync runs
   * afterwards so the latest folder state is always reflected.
   */
  async syncLedger() {
    if (this._syncing) { this._syncPending = true; return; }
    this._syncing = true;
    try {
      do {
        this._syncPending = false;
        await this._syncLedgerOnce();
      } while (this._syncPending);
    } finally {
      this._syncing = false;
    }
  }

  async _syncLedgerOnce() {
    if (!this.dirHandle) return;

    try {
      this.integrityWarnings = [];
      const mempoolDir = await this.dirHandle.getDirectoryHandle('mempool');
      const signaturesDir = await this.dirHandle.getDirectoryHandle('signatures');

      // 0. Self-heal: restore any committed files an attacker may have deleted.
      await this._restoreMissingFiles(mempoolDir, signaturesDir);

      // 1. Gather all files in mempool
      const rawTxs = [];
      const rawOrders = {}; // orderHash -> order
      const txFileContent = {}; // txHash -> original file text (for integrity mirror)

      for await (const entry of mempoolDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          const text = await file.text();
          try {
            const parsed = JSON.parse(text);
            if (entry.name.startsWith('order_')) {
              rawOrders[parsed.hash] = parsed;
            } else if (entry.name.startsWith('tx_')) {
              rawTxs.push(parsed);
              txFileContent[parsed.hash] = text;
            }
          } catch (e) {
            console.warn("Invalid JSON file:", entry.name);
          }
        }
      }

      // 2. Gather all witness signatures
      const sigs = {}; // txHash -> [{ witnessPubKey, sig }]
      const sigFileContent = {}; // sig file name -> original text (for integrity mirror)
      for await (const entry of signaturesDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          const text = await file.text();
          try {
            const sigObj = JSON.parse(text);
            if (sigObj.txHash && sigObj.witnessPubKey && sigObj.signature) {
              if (!sigs[sigObj.txHash]) sigs[sigObj.txHash] = [];
              sigs[sigObj.txHash].push(sigObj);
              sigFileContent[entry.name] = text;
            }
          } catch (e) {
            console.warn("Invalid signature file:", entry.name);
          }
        }
      }

      // Sort raw transactions deterministically: by timestamp, then by hash as a
      // stable tie-breaker. The hash is content-derived and identical on every
      // client, so all apps process equal-timestamp txs in the SAME order and
      // therefore agree on the single winner of any order race (consensus).
      rawTxs.sort((a, b) =>
        (a.timestamp - b.timestamp) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
      );

      // Reset in-memory ledger state
      this.transactions = [];
      this.balances = {};
      this.names = {};
      this.activeOrders = {};
      this.spentOrders = new Set();
      this.spentOrderBy = {};
      this.mempoolTransactions = [];
      this.signatures = {};
      this.initializedPlayers = new Set();

      const committedActivePeers = []; // List of public keys of committed players
      // Distinct senders of valid (non-duplicate) REGISTER_NAME txs seen so far,
      // in canonical order. Used as a STABLE denominator for the approval
      // threshold so that adding an approval can never retroactively un-commit a
      // peer (monotonicity). Unlike committedActivePeers this does NOT depend on
      // who is committed at a given moment, only on which registrations exist.
      const seenRegistrants = new Set();

      // 2c. Collect REJECT_REGISTRATION votes: targetHash -> Set of voter pubKeys.
      // Decentralized & egalitarian: ANY committed peer may cast a reject vote
      // (eligibility — committed, not the candidate — is enforced in the main
      // loop, mirroring how approval witnesses are validated). A reject vote does
      // NOT block on its own: a registration still commits as soon as it reaches
      // the approval threshold. Rejections only matter when there are enough of
      // them that the approval threshold can no longer be reached -> the
      // candidate is then marked rejected so they get feedback instead of waiting
      // forever.
      const rejectVotes = {}; // targetHash -> Set(voterPubKey)
      for (const tx of rawTxs) {
        if (tx.type !== "REJECT_REGISTRATION" || !tx.targetHash) continue;
        const v = { ...tx }; delete v.signature; delete v.hash;
        if (await CryptoHelper.verifySignature(tx.senderPubKey, tx.signature, v)) {
          if (!rejectVotes[tx.targetHash]) rejectVotes[tx.targetHash] = new Set();
          rejectVotes[tx.targetHash].add(tx.senderPubKey);
        }
      }
      this.rejectVotes = rejectVotes; // for UI (who already voted to reject what)

      // REGISTER_NAME tx hashes that became un-approvable (too many rejections).
      const rejectedRegHashes = new Set();
      this.rejectedRegHashes = rejectedRegHashes;

      // 3. Process transactions chronologically
      for (const tx of rawTxs) {
        // Exclude signature from data to verify against signature field
        const txToVerify = { ...tx };
        delete txToVerify.signature;
        delete txToVerify.hash;

        // Verify sender envelope signature
        const isSenderValid = await CryptoHelper.verifySignature(tx.senderPubKey, tx.signature, txToVerify);
        if (!isSenderValid) {
          console.warn(`Verwerfe Tx ${tx.hash}: Ungültige Absendersignatur.`);
          continue;
        }

        // REJECT_REGISTRATION votes carry no ledger state of their own; they were
        // already resolved into rejectedRegHashes above. Don't keep them as pending.
        if (tx.type === "REJECT_REGISTRATION") {
          continue;
        }

        // Process Signatures for this Tx.
        // SECURITY (Anti-Sybil): a witness only counts if it is an already
        // committed peer and is NOT a party to / sender of this transaction.
        // Otherwise an attacker could mint throwaway keys to fake consensus.
        const committedSet = new Set(committedActivePeers);
        const partyExclusion = new Set([tx.senderPubKey]);
        if (tx.type === "TRADE") {
          partyExclusion.add(tx.partyA);
          partyExclusion.add(tx.partyB);
        }

        const txSigs = sigs[tx.hash] || [];
        const validWitnesses = new Set();

        for (const s of txSigs) {
          if (!committedSet.has(s.witnessPubKey)) continue; // not an eligible peer
          if (partyExclusion.has(s.witnessPubKey)) continue; // can't witness own tx
          const isWitnessValid = await CryptoHelper.verifySignature(s.witnessPubKey, s.signature, tx.hash);
          if (isWitnessValid) {
            validWitnesses.add(s.witnessPubKey);
          }
        }

        this.signatures[tx.hash] = validWitnesses;

        // --- CONSENSUS VERIFICATION LOGIC ---
        let isCommitted = false;

        if (tx.type === "REGISTER_NAME") {
          // ANTI-SYBIL / HIJACKING RULE:
          // 1. First-come-first-served (no duplicate names).
          // 2. Approval by a configurable share of the peers registered BEFORE
          //    this candidate (stable threshold -> monotonic commits).
          const nameAlreadyTaken = Object.values(this.names).includes(tx.name);
          if (nameAlreadyTaken) {
            const existingOwner = Object.keys(this.names).find(k => this.names[k] === tx.name);
            if (existingOwner !== tx.senderPubKey) {
              console.warn(`Verwerfe Registrierung: Name '${tx.name}' bereits vergeben.`);
              continue; // Invalid, skip entirely
            }
          }

          const isAdmin = this.config.bootstrapAdmins.includes(tx.senderPubKey);

          // The approval threshold is derived from the number of DISTINCT peers
          // that registered BEFORE this candidate in canonical order
          // (seenRegistrants), NOT from how many are committed right now. This
          // keeps the requirement fixed per registration regardless of approval
          // order, so committing one peer can never raise another peer's bar and
          // un-commit it. (Previously this used committedActivePeers.length,
          // which grows during the pass and made commits non-monotonic.)
          const priorMemberCount = seenRegistrants.size;

          if (isAdmin) {
            // Pre-authorized founder key: auto-committed genesis admin.
            isCommitted = true;
          } else if (priorMemberCount === 0) {
            if (this.config.bootstrapAdmins.length === 0) {
              // No admin configured: fall back to "first registrant is genesis".
              // Less secure (timestamp is client-controlled) -> warn the operator.
              isCommitted = true;
              this._addIntegrityWarning(
                "Kein bootstrapAdmin gesetzt – der erste Registrierer wurde automatisch als Genesis akzeptiert. " +
                "Setze app.config.bootstrapAdmins auf den Public Key des Gründers."
              );
            } else {
              // Admins configured but none registered yet: nobody else may bootstrap.
              tx.approvalsRequired = 1;
              isCommitted = false;
            }
          } else {
            const requiredApprovals = Math.max(
              1,
              Math.ceil(priorMemberCount * this.config.registrationApprovalRatio)
            );
            tx.approvalsRequired = requiredApprovals;

            // Count reject votes from eligible (committed, non-candidate) peers.
            const rejecters = rejectVotes[tx.hash] || new Set();
            let eligibleRejections = 0;
            for (const r of rejecters) {
              if (committedSet.has(r) && r !== tx.senderPubKey) eligibleRejections++;
            }
            tx.rejectionCount = eligibleRejections;

            if (validWitnesses.size >= requiredApprovals) {
              // Approval threshold reached -> committed, regardless of how many
              // peers voted against (e.g. 75 for / 24 against still gets in).
              isCommitted = true;
            } else if (eligibleRejections > priorMemberCount - requiredApprovals) {
              // So many prior members rejected that even if ALL remaining ones
              // approved, the threshold could never be reached. The registration
              // is definitively rejected: give the candidate feedback instead of
              // letting them wait forever. It is dropped (neither committed nor
              // pending) and does not count toward later thresholds.
              rejectedRegHashes.add(tx.hash);
              console.warn(`Registrierung '${tx.name}' abgelehnt (Zulassung nicht mehr erreichbar).`);
              continue;
            }
          }

          // Record this registrant as a "seen" member for all subsequent
          // registrations' thresholds, independent of whether it commits.
          seenRegistrants.add(tx.senderPubKey);
        } else if (tx.type === "INITIALIZE_PLAYER") {
          // Only committed players may initialize, and only once (anti-reset).
          // The embedded starting allocation must match the consensus config.
          const isRegistered = committedSet.has(tx.senderPubKey);
          if (isRegistered && !this.initializedPlayers.has(tx.senderPubKey) && this._initAmountsValid(tx)) {
            const eligible = committedActivePeers.filter(p => p !== tx.senderPubKey).length;
            const required = Math.min(this.config.initWitnesses, eligible);
            tx.approvalsRequired = required;
            isCommitted = validWitnesses.size >= required;
          }
        } else if (tx.type === "TRADE") {
          // Needs independent auto-witnesses from committed, non-party peers.
          const eligible = committedActivePeers.filter(p => p !== tx.partyA && p !== tx.partyB).length;
          const required = Math.min(this.config.tradeWitnesses, eligible);
          tx.approvalsRequired = required;
          isCommitted = validWitnesses.size >= required;
        }

        tx.isCommitted = isCommitted;
        tx.witnessCount = validWitnesses.size;

        if (isCommitted) {
          const isValidStateTransition = await this._applyStateTransition(tx);
          if (isValidStateTransition) {
            this.transactions.push(tx);
            if (tx.type === "REGISTER_NAME" && !committedActivePeers.includes(tx.senderPubKey)) {
              committedActivePeers.push(tx.senderPubKey);
            }
          } else {
            console.warn(`Verwerfe committed Tx ${tx.hash}: Ungültige State-Transition.`);
          }
        } else {
          // Keep in mempool as pending
          this.mempoolTransactions.push(tx);
        }
      }

      // 3b. Resolve buy-races. A TRADE "lost" if a DIFFERENT trade already consumed
      // its order; such a trade can never commit. Drop it from the pending view so
      // it doesn't linger at 0 witnesses forever, and if it was OUR trade notify the
      // buyer once (no funds were moved on our side).
      const rejectedOwnTrades = [];
      const myKey = this.myKeys ? this.myKeys.pubKeyBase64 : null;
      const lostTradeHashes = new Set();
      for (const tx of rawTxs) {
        if (tx.type !== "TRADE") continue;
        const winner = this.spentOrderBy[tx.orderHash];
        if (!winner || winner === tx.hash) continue; // still contending, or it won
        lostTradeHashes.add(tx.hash);
        if (tx.senderPubKey === myKey && !this._notifiedRejected.has(tx.hash)) {
          this._notifiedRejected.add(tx.hash);
          rejectedOwnTrades.push(tx);
        }
      }
      this.mempoolTransactions = this.mempoolTransactions.filter(tx => !lostTradeHashes.has(tx.hash));

      // 4. Populate active orders (only those NOT spent by any committed or pending TRADE)
      for (const oHash of Object.keys(rawOrders)) {
        if (!this.spentOrders.has(oHash)) {
          const o = rawOrders[oHash];

          // Reject malformed orders (negative/zero/fractional amounts, bad price/asset).
          if (typeof o.asset !== "string" || !o.asset.startsWith("SHARE_")) continue;
          if (!Number.isInteger(o.amount) || o.amount <= 0) continue;
          if (!Number.isFinite(o.pricePerUnit) || o.pricePerUnit < 0) continue;

          if (o.type === "BUY_ORDER") {
            // Bind the order hash to its content so spentOrders dedup is reliable.
            const recomputedHash = await CryptoHelper.hashData({
              type: o.type, buyer: o.buyer, asset: o.asset, amount: o.amount,
              pricePerUnit: o.pricePerUnit, timestamp: o.timestamp, signature: o.signature
            });
            if (recomputedHash !== oHash) continue;

            const isOrderSigValid = await CryptoHelper.verifySignature(o.buyer, o.signature, {
              type: o.type, buyer: o.buyer, asset: o.asset, amount: o.amount, pricePerUnit: o.pricePerUnit, timestamp: o.timestamp
            });

            if (isOrderSigValid) {
              this.activeOrders[oHash] = o;
            }
          } else {
            // SELL_ORDER (default)
            // Bind the order hash to its content so spentOrders dedup is reliable.
            const recomputedHash = await CryptoHelper.hashData({
              type: o.type, seller: o.seller, asset: o.asset, amount: o.amount,
              pricePerUnit: o.pricePerUnit, timestamp: o.timestamp, signature: o.signature
            });
            if (recomputedHash !== oHash) continue;

            const isOrderSigValid = await CryptoHelper.verifySignature(o.seller, o.signature, {
              type: o.type, seller: o.seller, asset: o.asset, amount: o.amount, pricePerUnit: o.pricePerUnit, timestamp: o.timestamp
            });

            if (isOrderSigValid) {
              this.activeOrders[oHash] = o;
            }
          }
        }
      }

      // 5. Run background Auto-Witnessing for pending TRADE and INITIALIZE transactions
      await this._runAutoWitnessing();

      // 6. Persist an integrity mirror of all committed files so deletions can be healed.
      await this._persistMirror(txFileContent, sigFileContent);

      // 7. Ledger fingerprint: a short hash over the ordered committed tx hashes.
      //    Colleagues can compare it to confirm they all see the same history.
      this.ledgerFingerprint = this.transactions.length === 0
        ? "leer"
        : (await CryptoHelper.hashData(this.transactions.map(t => t.hash).join(","))).substring(0, 12);

      if (this.integrityWarnings.length > 0) {
        this.onIntegrityWarning(this.integrityWarnings);
      }

      // Determine our own registration status so the UI can show the right screen
      // and never re-publish a duplicate REGISTER_NAME.
      this.myRegistrationExists = false;
      this.myRegistrationRejected = false;
      this.myRegistrationDeclined = false;
      if (myKey && this.myName) {
        // Only consider registrations for our CURRENT name. After a decline the
        // old (rejected) tx stays in the folder forever; if we re-try (same or a
        // new name) that new request must take precedence over the stale one.
        const myRegsForName = rawTxs.filter(
          t => t.type === "REGISTER_NAME" && t.senderPubKey === myKey && t.name === this.myName
        );
        this.myRegistrationExists = myRegsForName.length > 0;
        // Declined only if EVERY request for the current name was rejected and we
        // have no still-pending / committed request for it. A fresh request
        // (not yet rejected) immediately clears the declined screen.
        const hasLiveRequest = myRegsForName.some(t => !this.rejectedRegHashes.has(t.hash));
        this.myRegistrationDeclined = myRegsForName.length > 0 && !hasLiveRequest;
        const iAmCommitted = Object.keys(this.names).includes(myKey);
        if (!iAmCommitted) {
          // Our name was rejected if some OTHER key already owns this exact name.
          this.myRegistrationRejected = Object.entries(this.names).some(
            ([k, n]) => n === this.myName && k !== myKey
          );
        }
      }

      if (rejectedOwnTrades.length > 0) {
        this.onTradeRejected(rejectedOwnTrades);
      }

      this.onStateChanged();
    } catch (e) {
      console.error("Ledger sync error:", e);
    }
  }

  _addIntegrityWarning(message) {
    if (!this.integrityWarnings.includes(message)) {
      this.integrityWarnings.push(message);
      console.warn("⚠️ Integrität:", message);
    }
  }

  /**
   * Stores the content of all committed tx files and the signature files that
   * back them in LocalStorage, so a malicious deletion can be detected and undone.
   */
  async _persistMirror(txFileContent, sigFileContent) {
    try {
      const mirror = { mempool: {}, signatures: {} };
      const committedHashes = new Set(this.transactions.map(t => t.hash));

      for (const hash of committedHashes) {
        if (txFileContent[hash]) {
          mirror.mempool[`tx_${hash}.json`] = txFileContent[hash];
        }
      }
      // Mirror the signature files that contributed to committed txs.
      for (const name of Object.keys(sigFileContent)) {
        try {
          const sigObj = JSON.parse(sigFileContent[name]);
          if (committedHashes.has(sigObj.txHash)) {
            mirror.signatures[name] = sigFileContent[name];
          }
        } catch (e) { /* ignore */ }
      }

      localStorage.setItem('tippspiel_integrity_mirror', JSON.stringify(mirror));
    } catch (e) {
      console.warn("Mirror persist failed:", e);
    }
  }

  /**
   * Restores committed files that have disappeared OR been tampered with in the
   * shared folder, using the LocalStorage mirror. Committed files are immutable
   * (hash-named), so any content mismatch against the mirror is an attack.
   */
  async _restoreMissingFiles(mempoolDir, signaturesDir) {
    let mirror;
    try {
      mirror = JSON.parse(localStorage.getItem('tippspiel_integrity_mirror') || 'null');
    } catch (e) {
      mirror = null;
    }
    if (!mirror) return;

    // Read current content of every file so we can detect deletion AND overwrite.
    const existing = { mempool: new Map(), signatures: new Map() };
    for await (const entry of mempoolDir.values()) {
      if (entry.kind === 'file') existing.mempool.set(entry.name, await (await entry.getFile()).text());
    }
    for await (const entry of signaturesDir.values()) {
      if (entry.kind === 'file') existing.signatures.set(entry.name, await (await entry.getFile()).text());
    }

    let deleted = 0, tampered = 0;
    const heal = async (dirHandle, store, name, content) => {
      if (!store.has(name)) { await this._writeFile(dirHandle, name, content); deleted++; }
      else if (store.get(name) !== content) { await this._writeFile(dirHandle, name, content); tampered++; }
    };

    for (const [name, content] of Object.entries(mirror.mempool || {})) {
      await heal(mempoolDir, existing.mempool, name, content);
    }
    for (const [name, content] of Object.entries(mirror.signatures || {})) {
      await heal(signaturesDir, existing.signatures, name, content);
    }

    if (deleted > 0 || tampered > 0) {
      const parts = [];
      if (deleted > 0) parts.push(`${deleted} gelöschte`);
      if (tampered > 0) parts.push(`${tampered} manipulierte`);
      this._addIntegrityWarning(
        `Ledger-Manipulation erkannt: ${parts.join(' und ')} Datei(en) wurden aus dem lokalen Backup wiederhergestellt.`
      );
    }
  }

  async _writeFile(dirHandle, name, content) {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  /**
   * Consensus check for INITIALIZE_PLAYER: the embedded starting allocation must
   * match the agreed config, otherwise a player could grant themselves arbitrary
   * funds/shares. Legacy txs without embedded amounts are accepted (they fall back
   * to config at apply time, so the applied value is config-bounded either way).
   */
  _initAmountsValid(tx) {
    if (tx.startEUR === undefined && tx.startShares === undefined) return true;
    return tx.startEUR === this.config.startEUR && tx.startShares === this.config.startShares;
  }

  /**
   * Applies transaction mutations to the global balances, spentOrders and names mappings.
   */
  async _applyStateTransition(tx) {
    const sender = tx.senderPubKey;
    this._ensureBalancesBucket(sender);

    if (tx.type === "REGISTER_NAME") {
      this.names[sender] = tx.name;
      return true;
    }

    if (tx.type === "INITIALIZE_PLAYER") {
      // Anti-reset: a player may only ever be initialized once. Without this an
      // attacker could re-send INITIALIZE_PLAYER to wipe debts / restore funds.
      if (this.initializedPlayers.has(sender)) {
        return false;
      }
      // The starting allocation is part of the signed transaction so the ledger
      // is self-contained and deterministic regardless of later config changes.
      // Legacy txs (created before amounts were embedded) fall back to config.
      // Note: the commit/witness gates already reject amounts that deviate from
      // the consensus config, so the applied value is always config-bounded.
      this.balances[sender].EUR = tx.startEUR ?? this.config.startEUR;
      this.balances[sender].SHARES[sender] = tx.startShares ?? this.config.startShares;
      this.initializedPlayers.add(sender);
      return true;
    }

    if (tx.type === "TRADE") {
      const partyA = tx.partyA; // Seller
      const partyB = tx.partyB; // Buyer
      
      this._ensureBalancesBucket(partyA);
      this._ensureBalancesBucket(partyB);

      // Structural validation: prevent minting via negative/fractional/mismatched values.
      if (typeof tx.giveAsset !== "string" || !tx.giveAsset.startsWith("SHARE_")) return false;
      if (tx.receiveAsset !== "EUR") return false;
      if (!Number.isInteger(tx.giveAmount) || tx.giveAmount <= 0) return false;
      if (!Number.isFinite(tx.receiveAmount) || tx.receiveAmount < 0) return false;
      if (!Number.isFinite(tx.pricePerUnit) || tx.pricePerUnit < 0) return false;
      // receiveAmount is NOT covered by either signature, so bind it to the
      // seller-signed price here, otherwise a buyer could pay 0 for shares.
      if (Math.abs(tx.receiveAmount - tx.giveAmount * tx.pricePerUnit) > 1e-9) return false;
      if (partyA === partyB) return false; // no wash trade with oneself

      if (!tx.orderHash) return false; // every trade must reference a concrete order
      if (this.spentOrders.has(tx.orderHash)) {
        return false; // Replay attack protection
      }

      // Bind orderHash to the signed order content. This makes spentOrders
      // dedup reliable so a single order signature can be spent exactly once.
      // The original order may have been a SELL_ORDER (seller-published, default
      // for older trades) or a BUY_ORDER (buyer-published).
      const orderType = tx.orderType || "SELL_ORDER";
      let recomputedOrderHash, isSellerSigValid, isBuyerSigValid;

      if (orderType === "BUY_ORDER") {
        // Buyer (partyB) published & signed the order; seller (partyA) signs execution.
        recomputedOrderHash = await CryptoHelper.hashData({
          type: "BUY_ORDER",
          buyer: partyB,
          asset: tx.giveAsset,
          amount: tx.giveAmount,
          pricePerUnit: tx.pricePerUnit,
          timestamp: tx.orderTimestamp,
          signature: tx.signatures.partyB
        });
        if (recomputedOrderHash !== tx.orderHash) return false;

        isBuyerSigValid = await CryptoHelper.verifySignature(partyB, tx.signatures.partyB, {
          type: "BUY_ORDER",
          buyer: partyB,
          asset: tx.giveAsset,
          amount: tx.giveAmount,
          pricePerUnit: tx.pricePerUnit,
          timestamp: tx.orderTimestamp
        });

        isSellerSigValid = await CryptoHelper.verifySignature(partyA, tx.signatures.partyA, {
          type: "SELL_EXECUTION",
          seller: partyA,
          orderHash: tx.orderHash,
          timestamp: tx.timestamp
        });
      } else {
        // Seller (partyA) published & signed the order; buyer (partyB) signs execution.
        recomputedOrderHash = await CryptoHelper.hashData({
          type: "SELL_ORDER",
          seller: partyA,
          asset: tx.giveAsset,
          amount: tx.giveAmount,
          pricePerUnit: tx.pricePerUnit,
          timestamp: tx.orderTimestamp,
          signature: tx.signatures.partyA
        });
        if (recomputedOrderHash !== tx.orderHash) return false;

        isSellerSigValid = await CryptoHelper.verifySignature(partyA, tx.signatures.partyA, {
          type: "SELL_ORDER",
          seller: partyA,
          asset: tx.giveAsset,
          amount: tx.giveAmount,
          pricePerUnit: tx.pricePerUnit,
          timestamp: tx.orderTimestamp
        });

        isBuyerSigValid = await CryptoHelper.verifySignature(partyB, tx.signatures.partyB, {
          type: "BUY_EXECUTION",
          buyer: partyB,
          orderHash: tx.orderHash,
          timestamp: tx.timestamp
        });
      }

      if (!isSellerSigValid || !isBuyerSigValid) {
        return false;
      }

      // Check seller has enough shares
      const shareOwner = tx.giveAsset.replace("SHARE_", "");
      if ((this.balances[partyA].SHARES[shareOwner] || 0) < tx.giveAmount) {
        return false;
      }

      // Check buyer has enough EUR
      if (this.balances[partyB].EUR < tx.receiveAmount) {
        return false;
      }

      // Execute exchange
      this.balances[partyA].SHARES[shareOwner] -= tx.giveAmount;
      this.balances[partyA].EUR += tx.receiveAmount;

      this.balances[partyB].SHARES[shareOwner] = (this.balances[partyB].SHARES[shareOwner] || 0) + tx.giveAmount;
      this.balances[partyB].EUR -= tx.receiveAmount;

      if (tx.orderHash) {
        this.spentOrders.add(tx.orderHash);
        this.spentOrderBy[tx.orderHash] = tx.hash;
      }

      return true;
    }

    return false;
  }

  _ensureBalancesBucket(pubKey) {
    if (!this.balances[pubKey]) {
      this.balances[pubKey] = {
        EUR: 0.00,
        SHARES: {}
      };
    }
  }

  /**
   * Scans mempool transactions. Automatically validates and witnesses trades & initializations.
   * Skip REGISTER_NAME (those are human-in-the-loop manual approvals!).
   */
  async _runAutoWitnessing() {
    if (!this.myKeys || !this.dirHandle) return;

    const signaturesDir = await this.dirHandle.getDirectoryHandle('signatures');
    const wid = (await CryptoHelper.hashData(this.myKeys.pubKeyBase64)).substring(0, 16);

    for (const tx of this.mempoolTransactions) {
      const mySigs = this.signatures[tx.hash] || new Set();
      if (mySigs.has(this.myKeys.pubKeyBase64)) {
        continue; // Already signed by us
      }

      if (tx.senderPubKey === this.myKeys.pubKeyBase64) {
        continue; // Don't witness our own actions
      }

      // Only committed peers may act as witnesses; if we aren't committed yet our
      // signature wouldn't count anyway, so don't pollute the folder.
      if (!Object.keys(this.names).includes(this.myKeys.pubKeyBase64)) {
        continue;
      }

      // SECURITY RULE:
      // Skip manual registration approvals (REGISTER_NAME requires manual user click / 75% consensus!)
      if (tx.type === "REGISTER_NAME") {
        continue; 
      }

      // Skip initialize player if sender isn't a committed player, already
      // initialized, or claims a starting allocation that deviates from config.
      if (tx.type === "INITIALIZE_PLAYER") {
        const isRegistered = Object.keys(this.names).includes(tx.senderPubKey);
        if (!isRegistered) continue;
        if (this.initializedPlayers.has(tx.senderPubKey)) continue;
        if (!this._initAmountsValid(tx)) continue;
      }

      // Validate Trade balances before auto-signing
      if (tx.type === "TRADE") {
        // Never witness a trade we are a party to.
        if (tx.partyA === this.myKeys.pubKeyBase64 || tx.partyB === this.myKeys.pubKeyBase64) {
          continue;
        }

        // Ensure state buckets exist
        this._ensureBalancesBucket(tx.partyA);
        this._ensureBalancesBucket(tx.partyB);

        // Mirror the structural checks from _applyStateTransition so we never
        // witness an economically invalid (e.g. free-shares) trade.
        if (!tx.giveAsset || !tx.giveAsset.startsWith("SHARE_")) continue;
        if (tx.receiveAsset !== "EUR") continue;
        if (!Number.isInteger(tx.giveAmount) || tx.giveAmount <= 0) continue;
        if (!Number.isFinite(tx.receiveAmount) || tx.receiveAmount < 0) continue;
        if (!Number.isFinite(tx.pricePerUnit) || tx.pricePerUnit < 0) continue;
        if (Math.abs(tx.receiveAmount - tx.giveAmount * tx.pricePerUnit) > 1e-9) continue;

        // Dry-run check: does seller still have the shares? Does buyer still have EUR?
        const shareOwner = tx.giveAsset.replace("SHARE_", "");
        const sellerShares = this.balances[tx.partyA].SHARES[shareOwner] || 0;
        const buyerEUR = this.balances[tx.partyB].EUR || 0;

        if (sellerShares < tx.giveAmount || buyerEUR < tx.receiveAmount) {
          continue; // State no longer valid, skip auto-signing!
        }

        // Flip mitigation: only witness the EARLIEST claimant of an order so the
        // committed winner of a buy-race can't temporarily flip back and forth.
        // Skip if the order is already spent by a committed trade, or if another
        // trade with an earlier (timestamp, then hash) ordering also claims it.
        if (this.spentOrders.has(tx.orderHash)) continue;
        const earlierClaimantExists = [...this.mempoolTransactions, ...this.transactions].some(other =>
          other.type === "TRADE" && other.orderHash === tx.orderHash && other.hash !== tx.hash &&
          ((other.timestamp < tx.timestamp) ||
           (other.timestamp === tx.timestamp && other.hash < tx.hash))
        );
        if (earlierClaimantExists) continue;
      }

      // Sign tx hash as witness
      const witnessSignature = await CryptoHelper.signData(this.myKeys.privateKey, tx.hash);
      
      const sigObj = {
        txHash: tx.hash,
        witnessPubKey: this.myKeys.pubKeyBase64,
        signature: witnessSignature
      };

      const fileHandle = await signaturesDir.getFileHandle(`sig_${tx.hash}_${wid}.json`, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(sigObj, null, 2));
      await writable.close();

      console.log(`✓ Automatisch signiert: Tx ${tx.hash.substring(0, 8)}`);
    }
  }

  /**
   * Builds the price history per share from the committed ledger.
   *
   * Every Kollegen-AG starts at `config.initialSharePrice` (default 0.05 EUR)
   * at the moment its owner is registered. Each committed TRADE then sets a new
   * quoted price (`pricePerUnit`) for that share at the trade's timestamp.
   *
   * Returns: { "SHARE_<ownerPubKey>": [ { timestamp, price }, ... ] }
   * sorted chronologically. Only shares of registered owners are included.
   */
  getPriceHistory() {
    const initial = this.config.initialSharePrice;
    const history = {};

    // Seed every registered share with its initial price at registration time.
    for (const tx of this.transactions) {
      if (tx.type === "REGISTER_NAME") {
        const asset = `SHARE_${tx.senderPubKey}`;
        if (!history[asset]) {
          history[asset] = [{ timestamp: tx.timestamp, price: initial }];
        }
      }
    }

    // Apply every committed trade as a new price point for its share.
    const trades = this.transactions
      .filter(t => t.type === "TRADE")
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const t of trades) {
      if (!history[t.giveAsset]) {
        // Share owner not (yet) seen via REGISTER_NAME – seed defensively.
        history[t.giveAsset] = [{ timestamp: t.timestamp, price: initial }];
      }
      history[t.giveAsset].push({ timestamp: t.timestamp, price: t.pricePerUnit });
    }

    return history;
  }
}
