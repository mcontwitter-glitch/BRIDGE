/* One-shot destination delivery. Not a poller.
   After a lock (or burn-to-return) receipt, ask /api/sign-relay for a signature
   over the PacketSent payload hash, then prompt the user to sign verifyAndCommit
   on the destination chain. The signer never sends that transaction. */
(function () {
  var PACKET_SENT = "0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f";
  var SELECTOR = "6c64cbfc";

  function hex(value) {
    return String(value || "").replace(/^0x/i, "").toLowerCase();
  }

  function decodeFirstBytes(data) {
    var raw = hex(data);
    var offset = parseInt(raw.slice(0, 64), 16) * 2;
    var len = parseInt(raw.slice(offset, offset + 64), 16);
    return "0x" + raw.slice(offset + 64, offset + 64 + len * 2);
  }

  function packetFromReceipt(receipt) {
    var logs = (receipt && receipt.logs) || [];
    for (var i = 0; i < logs.length; i++) {
      var entry = logs[i];
      var topic = entry.topics && entry.topics[0];
      if (!topic || topic.toLowerCase() !== PACKET_SENT) continue;
      try {
        return decodeFirstBytes(entry.data);
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  function dstEid(packet) {
    return parseInt(hex(packet).slice(45 * 2, 49 * 2), 16);
  }

  function encBytes(value) {
    var body = hex(value);
    var len = (body.length / 2).toString(16).padStart(64, "0");
    var words = Math.ceil(body.length / 64) || 0;
    return len + body.padEnd(words * 64, "0");
  }

  function encodeVerify(packet, signature) {
    var a = encBytes(packet);
    var b = encBytes(signature);
    var offA = (64).toString(16).padStart(64, "0");
    var offB = (64 + a.length / 2).toString(16).padStart(64, "0");
    return "0x" + SELECTOR + offA + offB + a + b;
  }

  var CHAIN_META = {
    1: { name: "Ethereum", sym: "ETH" },
    56: { name: "BNB Chain", sym: "BNB" },
    2741: { name: "Abstract", sym: "ETH" },
    4663: { name: "Robinhood Chain", sym: "ETH" },
    8453: { name: "Base", sym: "ETH" },
    33139: { name: "ApeChain", sym: "APE" },
  };
  async function switchOrAdd(chainId, cfg) {
    var hexId = "0x" + chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (err) {
      var code = err && (err.code || (err.data && err.data.originalError && err.data.originalError.code));
      var chain = cfg && cfg.chains && cfg.chains[String(chainId)];
      var meta = CHAIN_META[chainId];
      if (code !== 4902 || !chain || !meta) throw err;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hexId, chainName: meta.name, nativeCurrency: { name: meta.sym, symbol: meta.sym, decimals: 18 }, rpcUrls: chain.rpc.slice(0, 1) }],
      });
    }
  }

  async function bridgeDeliverMint(opts) {
    var step = opts.step || "mint";
    var onStep = opts.onStep || function () {};
    var txHash = opts.receipt && (opts.receipt.transactionHash || opts.receipt.hash);
    if (!txHash) throw new Error("The lock receipt has no transaction hash.");
    var localPacket = packetFromReceipt(opts.receipt);
    if (!localPacket || hex(localPacket).length < 113 * 2) {
      throw new Error("The lock transaction has no PacketSent log, so there is nothing to mint.");
    }
    onStep(step, "active", "Requesting the one-shot mint signature…");
    var cfg = await fetch("/dvn.json").then(function (r) {
      if (!r.ok) throw new Error("dvn.json is missing");
      return r.json();
    });
    var signUrl = (cfg.signRelayUrl || "/api/sign-relay").replace(/\/$/, "");
    var body;
    try {
      var res = await fetch(signUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          txHash: txHash,
          srcChainId: opts.srcChainId,
        }),
      });
      var text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 280) || "HTTP " + res.status);
      body = JSON.parse(text);
    } catch (err) {
      var why = err && err.message ? err.message : String(err);
      throw new Error(
        "Could not get the mint signature (" +
          why +
          "). Deploy worker/sign-relay (BRIDGE_RELAY_SIGNER_PK secret) and set docs/dvn.json signRelayUrl, or run `node script/signRelay.mjs --tx " +
          txHash +
          " --src-chain " +
          opts.srcChainId +
          "`. The signer does not send a transaction, and nothing on this page polls.",
      );
    }
    if (!body || !body.signature || !body.encodedPacket) throw new Error("The signer did not return a packet and signature.");
    var dvn = body.verifier || (cfg.byEid && cfg.byEid[String(body.dstEid || dstEid(body.encodedPacket))]);
    if (!dvn) throw new Error("No destination verifier is configured for this route.");
    if (body.dstChainId) opts.destChainId = Number(body.dstChainId);
    onStep(step, "active", "Switch to the destination chain and sign the mint. You pay this gas.");
    if (opts.switchChain) await opts.switchChain({ chainId: opts.destChainId });
    else if (window.ethereum) {
      await switchOrAdd(Number(opts.destChainId), cfg);
    } else {
      throw new Error("Connect a wallet to sign the mint.");
    }
    var abi = [
      {
        type: "function",
        name: "verifyAndCommit",
        stateMutability: "payable",
        inputs: [
          { name: "encodedPacket", type: "bytes" },
          { name: "signature", type: "bytes" },
        ],
        outputs: [],
      },
    ];
    var hash;
    if (opts.writeContractAsync) {
      hash = await opts.writeContractAsync({
        address: dvn,
        abi: abi,
        functionName: "verifyAndCommit",
        args: [body.encodedPacket, body.signature],
        chainId: opts.destChainId,
      });
    } else {
      var from = (await window.ethereum.request({ method: "eth_accounts" }))[0];
      hash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: from, to: dvn, data: encodeVerify(body.encodedPacket, body.signature) }],
      });
    }
    onStep(step, "done", typeof hash === "string" ? hash : "submitted");
    return hash;
  }

  window.bridgeDeliverMint = bridgeDeliverMint;

  /* Safety guard used by the lock / unlock flow before any wallet prompt. */
  var cfgPromise = null;
  function loadCfg() {
    if (!cfgPromise) {
      cfgPromise = fetch("/dvn.json", { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("dvn.json is missing");
        return r.json();
      });
    }
    return cfgPromise;
  }
  var DEFAULT_CAP = 10000000000000000n; // 0.01 native
  var SYMBOL = { 2741: "ETH", 1: "ETH", 8453: "ETH", 4663: "ETH", 56: "BNB", 33139: "APE" };
  function fmt(wei) {
    var w = BigInt(wei);
    var whole = w / 1000000000000000000n;
    var frac = (w % 1000000000000000000n).toString().padStart(18, "0").slice(0, 6);
    return whole.toString() + "." + frac;
  }
  var CREDIT_ABI = [
    {
      type: "function",
      name: "pushCredit",
      stateMutability: "view",
      inputs: [
        { name: "depositor", type: "address" },
        { name: "collection", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
  ];
  async function rpcCall(urls, method, params) {
    for (var i = 0; i < urls.length; i++) {
      try {
        var r = await fetch(urls[i], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
        });
        var j = await r.json();
        if (j && j.result !== undefined && j.result !== null) return typeof j.result === "string" && /^0x[0-9a-f]*$/i.test(j.result) && method !== "eth_getTransactionReceipt" ? BigInt(j.result === "0x" ? 0 : j.result) : j.result;
      } catch (e) {}
    }
    return null;
  }
  var bridgeGuard = {
    checkFee: async function (o) {
      var cfg = await loadCfg();
      var isLock = Number(o.chainId) === 2741;
      if (isLock && (cfg.lockPaused || cfg.sendPaused)) throw new Error(cfg.lockPausedReason || cfg.sendPausedReason || "Bridging is paused.");
      if (!isLock && cfg.returnPaused) throw new Error(cfg.returnPausedReason || "Returns are paused.");
      var cap = DEFAULT_CAP;
      if (cfg.maxNativeFee && cfg.maxNativeFee[String(o.chainId)]) cap = BigInt(cfg.maxNativeFee[String(o.chainId)]);
      var fee = BigInt(o.fee);
      if (fee > cap) {
        var sym = SYMBOL[o.chainId] || "native";
        throw new Error(
          "Quoted LayerZero fee " + fmt(fee) + " " + sym + " is above the safety cap of " + fmt(cap) + " " + sym + ". Not submitting.",
        );
      }
      return fee;
    },
    credit: async function (o) {
      if (!o.readContract) return 0n;
      try {
        var v = await o.readContract({
          address: o.contract,
          abi: CREDIT_ABI,
          functionName: "pushCredit",
          args: [o.user, o.collection, BigInt(o.tokenId)],
        });
        return BigInt(v || 0);
      } catch (err) {
        return 0n;
      }
    },
    funds: async function (o) {
      // Plain "not enough ETH" check before any wallet prompt, so wallets never
      // show their huge fake gas estimate when the balance is too low.
      var cfg = await loadCfg();
      var chain = cfg.chains && cfg.chains[String(o.chainId)];
      if (!chain || !chain.rpc || !o.user) return;
      async function rpc(method, params) {
        for (var i = 0; i < chain.rpc.length; i++) {
          try {
            var r = await fetch(chain.rpc[i], {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
            });
            var j = await r.json();
            if (j && j.result) return BigInt(j.result);
          } catch (e) {}
        }
        return null;
      }
      var bal = await rpc("eth_getBalance", [o.user, "latest"]);
      if (bal === null) return; // RPC down: don't block, the wallet still checks
      var gp = await rpc("eth_gasPrice", []);
      var fee = BigInt(o.fee || 0);
      var credit = BigInt(o.credit || 0);
      var owed = fee > credit ? fee - credit : 0n;
      var gas = gp === null ? 0n : (gp * 3000000n * 3n) / 2n; // fee payment + NFT transfer, with headroom
      var need = owed + gas;
      if (bal < need) {
        var sym = SYMBOL[o.chainId] || "native";
        var where = chain.name ? chain.name.charAt(0).toUpperCase() + chain.name.slice(1) : "this chain";
        throw new Error(
          "Not enough " + sym + " on " + where + ". This bridge needs about " + fmt(need) + " " + sym +
            " (bridge fee " + fmt(owed) + " + gas), but this wallet has " + fmt(bal) + " " + sym +
            ". Add a little " + sym + " on " + where + " and try again. Nothing was sent.",
        );
      }
    },
    destGas: async function (o) {
      // The mint on the destination is a second transaction the same wallet signs,
      // so it needs gas there too. Check before anything is locked.
      var cfg = await loadCfg();
      var chain = cfg.chains && cfg.chains[String(o.chainId)];
      if (!chain || !chain.rpc || !o.user) return;
      var bal = await rpcCall(chain.rpc, "eth_getBalance", [o.user, "latest"]);
      var gp = await rpcCall(chain.rpc, "eth_gasPrice", []);
      if (bal === null || gp === null) return;
      var need = (gp * 600000n * 3n) / 2n;
      if (bal < need) {
        var meta = CHAIN_META[o.chainId] || { name: chain.name || "the destination chain", sym: "native" };
        throw new Error(
          "Your wallet needs a little " + meta.sym + " on " + meta.name + " to sign the mint there (about " + fmt(need) + " " + meta.sym +
            ", it has " + fmt(bal) + "). Add some on " + meta.name + " first. Nothing was locked.",
        );
      }
    },
    simulate: async function (o) {
      if (!o.readContract) throw new Error("Cannot check the transfer without a read client.");
      try {
        await o.readContract({
          address: o.address,
          abi: o.abi,
          functionName: "safeTransferFrom",
          args: o.args,
          account: o.account,
        });
      } catch (err) {
        var why = (err && (err.shortMessage || err.message)) || String(err);
        throw new Error(
          "This transfer would revert on-chain (" +
            why.split("\n")[0].slice(0, 160) +
            "), so you were not asked to sign it and nothing moved. Any fee you prepaid stays credited to you and is used on the next try; withdrawPushCredit(" +
            o.collection +
            ", " +
            String(o.tokenId) +
            ") on " +
            o.contract +
            " returns it.",
        );
      }
    },
  };
  window.bridgeGuard = bridgeGuard;
  /* "Finish a stuck mint": for a lock (or return) whose second step was never
     signed. Holder pastes the lock tx; anyone may pay the gas, the twin always
     goes to the recipient written in the lock. */
  async function finishStuckMint(srcChainId, txHash, say) {
    var cfg = await loadCfg();
    txHash = String(txHash || "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Paste the full lock transaction hash (0x… 66 characters).");
    var src = cfg.chains && cfg.chains[String(srcChainId)];
    if (!src) throw new Error("Unknown source chain.");
    say("Looking up the lock transaction…");
    var receipt = await rpcCall(src.rpc, "eth_getTransactionReceipt", [txHash]);
    if (!receipt) throw new Error("That transaction wasn't found on " + (CHAIN_META[srcChainId] || {}).name + ". Check the hash and the chain.");
    if (receipt.status !== "0x1") throw new Error("That transaction failed on-chain, so nothing was locked.");
    say("Getting the mint signature…");
    var signUrl = (cfg.signRelayUrl || "/api/sign-relay").replace(/\/$/, "");
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl && setTimeout(function () { ctl.abort(); }, 20000);
    var res;
    var payload = JSON.stringify({ txHash: txHash, srcChainId: Number(srcChainId) });
    try {
      try {
        res = await fetch(signUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: ctl ? ctl.signal : undefined,
        });
      } catch (first) {
        if (first && first.name === "AbortError") throw first;
        // Some mobile wallet browsers fail the CORS preflight; retry as a simple request.
        res = await fetch(signUrl, { method: "POST", headers: { "content-type": "text/plain" }, body: payload, signal: ctl ? ctl.signal : undefined });
      }
    } catch (err) {
      throw new Error("Couldn't reach the mint signer (" + ((err && err.name === "AbortError") ? "timed out" : (err && err.message) || err) + "). Check your connection and try again.");
    } finally {
      if (timer) clearTimeout(timer);
    }
    var text = await res.text();
    if (!res.ok) throw new Error("The signer refused this transaction: " + text.slice(0, 200));
    var body = JSON.parse(text);
    var dst = Number(body.dstChainId);
    var dvn = body.verifier || (cfg.byEid && cfg.byEid[String(body.dstEid || dstEid(body.encodedPacket))]);
    var dchain = cfg.chains[String(dst)];
    var meta = CHAIN_META[dst] || { name: "the destination", sym: "native" };
    if (!dvn || !dchain) throw new Error("No verifier is configured for that destination.");
    if (!window.ethereum) throw new Error("Open this page in a wallet browser or with a wallet extension to sign the mint.");
    say("Signature received. Connecting to your wallet…");
    var accs = [];
    try { accs = await window.ethereum.request({ method: "eth_accounts" }); } catch (e) {}
    if (!accs || !accs[0]) {
      say("Approve the connection request in your wallet (open the wallet if no popup appeared).");
      accs = await Promise.race([
        window.ethereum.request({ method: "eth_requestAccounts" }),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error("Your wallet didn't respond to the connection request. Open your wallet, approve or reject any pending request, then try again.")); }, 90000); }),
      ]);
    }
    var from = accs[0];
    var data = encodeVerify(body.encodedPacket, body.signature);
    say("Checking the mint on " + meta.name + "…");
    var sim = await rpcCall(dchain.rpc, "eth_call", [{ from: from, to: dvn, data: data }, "latest"]);
    if (sim === null) throw new Error("This mint can't go through on " + meta.name + ". It has most likely already been minted. Nothing was sent.");
    var bal = await rpcCall(dchain.rpc, "eth_getBalance", [from, "latest"]);
    var gp = await rpcCall(dchain.rpc, "eth_gasPrice", []);
    if (bal !== null && gp !== null && bal < (gp * 600000n * 3n) / 2n) {
      throw new Error("Your wallet needs a little " + meta.sym + " on " + meta.name + " for gas (it has " + fmt(bal) + "). Add some and try again.");
    }
    say("Switch to " + meta.name + " and sign the mint. You pay only the gas.");
    await switchOrAdd(dst, cfg);
    var hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: from, to: dvn, data: data }] });
    say("Mint sent on " + meta.name + ": " + hash + ". The twin goes to the wallet that locked it.");
    return hash;
  }
  window.finishStuckMint = finishStuckMint;
  /* Stuck-mint finder: every NFT still sitting in the Abstract vault whose twin
     never minted. Mints on a route must go in lock order (nonce), across all
     holders, so the list is sorted and only the first per route is "ready". */
  var VAULT = "0xe81DdAB112137112B8FeeB853e22BC4c38F999e5";
  var TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  var MINTER = { 1: "0xDd3E6cc04168bCFC1ACaE5e70748618C5b38092B", 8453: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f", 56: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f", 33139: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f", 4663: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f" };
  function word(v) {
    return hex(v).padStart(64, "0");
  }
  async function ethCallRaw(urls, to, data) {
    for (var i = 0; i < urls.length; i++) {
      try {
        var r = await fetch(urls[i], {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: to, data: data }, "latest"] }),
        });
        var j = await r.json();
        if (j.result !== undefined) return { ok: true, data: j.result };
        if (j.error && (j.error.code === 3 || /revert/i.test(j.error.message || ""))) return { ok: false, data: (j.error.data && (j.error.data.data || j.error.data)) || "" };
      } catch (e) {}
    }
    return null;
  }
  async function poolMap(items, n, fn) {
    var out = new Array(items.length), i = 0;
    async function run() {
      while (i < items.length) {
        var k = i++;
        out[k] = await fn(items[k]);
      }
    }
    var ws = [];
    for (var w = 0; w < Math.min(n, items.length); w++) ws.push(run());
    await Promise.all(ws);
    return out;
  }
  var twinCache = {};
  async function scanStuck(say) {
    var cfg = await loadCfg();
    var abs = cfg.chains["2741"].rpc;
    var eidToChain = {};
    Object.keys(cfg.chains).forEach(function (id) {
      eidToChain[cfg.chains[id].eid] = Number(id);
    });
    say("Reading vault locks…");
    var logs = await rpcCall(abs, "eth_getLogs", [{ fromBlock: "0x52a0000", toBlock: "latest", topics: [TRANSFER, null, "0x" + word(VAULT)] }]);
    if (!logs) throw new Error("Couldn't read the vault's locks right now. Try again in a minute.");
    logs = logs.filter(function (l) {
      return l.topics.length === 4;
    });
    say("Checking " + logs.length + " locks…");
    var rows = await poolMap(logs, 6, async function (l) {
      var tokenId = BigInt(l.topics[3]);
      var owner = await ethCallRaw(abs, l.address, "0x6352211e" + word(tokenId.toString(16)));
      if (!owner || !owner.ok || hex(owner.data).slice(24) !== hex(VAULT)) return null; // returned already
      var rc = await rpcCall(abs, "eth_getTransactionReceipt", [l.transactionHash]);
      var pk = rc && packetFromReceipt(rc);
      if (!pk) return null;
      var p = hex(pk);
      var dst = eidToChain[parseInt(p.slice(90, 98), 16)];
      if (!dst || !MINTER[dst]) return null;
      var drpc = cfg.chains[String(dst)].rpc;
      var key = dst + ":" + l.address.toLowerCase();
      if (!(key in twinCache)) {
        var t = await ethCallRaw(drpc, MINTER[dst], "0x3e94c904" + word(l.address));
        twinCache[key] = t && t.ok ? "0x" + hex(t.data).slice(24) : null;
      }
      var twin = twinCache[key];
      if (twin && !/^0x0+$/.test(twin)) {
        var o = await ethCallRaw(drpc, twin, "0x6352211e" + word(tokenId.toString(16)));
        if (o === null || o.ok) return null; // minted (or RPC down: don't show)
      }
      return {
        tokenId: tokenId.toString(),
        collection: l.address,
        from: "0x" + hex(l.topics[1]).slice(24),
        tx: l.transactionHash,
        dst: dst,
        nonce: parseInt(p.slice(2, 18), 16),
      };
    });
    rows = rows.filter(Boolean);
    // Drop packets the destination has already moved past (delivered or skipped).
    var lazy = {};
    var dsts = rows.map(function (r) { return r.dst; }).filter(function (d, i, a) { return a.indexOf(d) === i; });
    await Promise.all(dsts.map(async function (d) {
      var c = cfg.chains[String(d)];
      var res = await ethCallRaw(c.rpc, c.endpoint, "0x5b17bb70" + word(MINTER[d]) + word((30324).toString(16)) + word(VAULT));
      lazy[d] = res && res.ok ? parseInt(hex(res.data) || "0", 16) : 0;
    }));
    rows = rows.filter(function (r) { return r.nonce > lazy[r.dst]; }).sort(function (a, b) {
      return a.dst - b.dst || a.nonce - b.nonce;
    });
    var seen = {};
    rows.forEach(function (r) {
      r.blocker = seen[r.dst] || null;
      r.ready = !r.blocker && r.nonce === lazy[r.dst] + 1;
      if (!seen[r.dst]) seen[r.dst] = r;
    });
    return rows;
  }
  window.scanStuckMints = scanStuck;

  function mountFinishPanel() {
    if (document.getElementById("stuck-mint-btn")) return;
    var btn = document.createElement("button");
    btn.id = "stuck-mint-btn";
    btn.textContent = "Stuck mint? Finish it";
    btn.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:9999;padding:10px 14px;border-radius:10px;border:1px solid #444;background:#1b1b1b;color:#fff;font:600 13px Inter,sans-serif;cursor:pointer";
    var box = document.createElement("div");
    box.style.cssText = "display:none;position:fixed;right:16px;bottom:64px;z-index:9999;width:360px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;padding:16px;border-radius:12px;border:1px solid #444;background:#111;color:#eee;font:13px/1.4 Inter,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)";
    var field = "width:100%;box-sizing:border-box;margin:6px 0 10px;padding:8px;border-radius:8px;border:1px solid #444;background:#1b1b1b;color:#fff;font:13px Inter,sans-serif";
    var primary = "width:100%;padding:10px;border-radius:8px;border:0;background:#f5a623;color:#111;font:700 13px Inter,sans-serif;cursor:pointer";
    var opts = "";
    [[1, "Ethereum"], [8453, "Base"], [56, "BNB Chain"], [33139, "ApeChain"], [4663, "Robinhood Chain"], [2741, "Abstract"]].forEach(function (c) {
      opts += '<option value="' + c[0] + '">' + c[1] + "</option>";
    });
    box.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px">Finish a stuck mint</div>' +
      '<div style="color:#aaa;margin-bottom:10px">Locked an NFT but the twin never showed up? Find it here and sign the mint. You need a little gas on the destination chain. The twin always goes to the wallet that locked it.</div>' +
      '<label>Wallet that locked the NFTs<input id="stuck-addr" placeholder="0x…" style="' + field + '"></label>' +
      '<button id="stuck-find" style="' + primary + '">Find my stuck mints</button>' +
      '<div id="stuck-list" style="margin-top:12px"></div>' +
      '<div id="stuck-msg" style="margin-top:10px;word-break:break-all;color:#ccc"></div>' +
      '<details style="margin-top:12px;color:#aaa"><summary style="cursor:pointer">Returning a twin? Paste the transaction</summary>' +
      '<label>Chain you sent from<select id="stuck-src" style="' + field + '">' + opts + "</select></label>" +
      '<label>Transaction hash<input id="stuck-tx" placeholder="0x…" style="' + field + '"></label>' +
      '<button id="stuck-go" style="' + primary + '">Finish</button></details>';
    document.body.appendChild(box);
    document.body.appendChild(btn);
    var msg = box.querySelector("#stuck-msg");
    var list = box.querySelector("#stuck-list");
    var addr = box.querySelector("#stuck-addr");
    function say(t, color) {
      msg.style.color = color || "#ccc";
      msg.textContent = t;
    }
    function fail(err) {
      say((err && (err.shortMessage || err.message)) || String(err), "#ff8a80");
    }
    btn.onclick = async function () {
      box.style.display = box.style.display === "none" ? "block" : "none";
      if (box.style.display === "block" && !addr.value && window.ethereum) {
        try {
          var acc = await window.ethereum.request({ method: "eth_accounts" });
          if (acc && acc[0]) addr.value = acc[0];
        } catch (e) {}
      }
    };
    async function finish(row, button) {
      button.disabled = true;
      try {
        await finishStuckMint(2741, row.tx, say);
        say("Mint sent for #" + row.tokenId + ". Give it a few seconds, then search again for the next one.", "#7ddc8a");
      } catch (err) {
        fail(err);
      } finally {
        button.disabled = false;
      }
    }
    async function find() {
      var who = addr.value.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(who)) return say("Enter the wallet address that locked the NFTs.", "#ff8a80");
      list.innerHTML = "";
      var go = box.querySelector("#stuck-find");
      go.disabled = true;
      try {
        var rows = await scanStuck(say);
        var mine = rows.filter(function (r) { return r.from === who; });
        var shown = [];
        mine.forEach(function (r) {
          if (r.blocker && r.blocker.from !== who && shown.indexOf(r.blocker) < 0) shown.push(r.blocker);
          shown.push(r);
        });
        shown = shown.filter(function (r, i, a) { return a.indexOf(r) === i; });
        if (!shown.length) return say("No stuck mints for this wallet. Everything it locked has minted.", "#7ddc8a");
        say("");
        shown.forEach(function (r) {
          var meta = CHAIN_META[r.dst] || { name: "chain " + r.dst };
          var row = document.createElement("div");
          row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #2a2a2a";
          var label = document.createElement("div");
          label.style.cssText = "flex:1";
          var note = r.from !== who ? "Another holder's lock, ahead of yours. You can finish it for them." : r.ready ? "Ready to mint" : r.blocker ? "Mints after #" + r.blocker.tokenId : "Waiting for an earlier lock on this route";
          label.innerHTML = "<b>#" + r.tokenId + "</b> to " + meta.name + '<div style="color:#999;font-size:12px">' + note + "</div>";
          row.appendChild(label);
          if (r.ready) {
            var b = document.createElement("button");
            b.textContent = "Mint";
            b.style.cssText = "padding:6px 12px;border-radius:8px;border:0;background:#f5a623;color:#111;font:700 12px Inter,sans-serif;cursor:pointer";
            b.onclick = function () { finish(r, b); };
            row.appendChild(b);
          }
          list.appendChild(row);
        });
      } catch (err) {
        fail(err);
      } finally {
        go.disabled = false;
      }
    }
    box.querySelector("#stuck-find").onclick = find;
    var goTx = box.querySelector("#stuck-go");
    goTx.onclick = async function () {
      goTx.disabled = true;
      try {
        await finishStuckMint(box.querySelector("#stuck-src").value, box.querySelector("#stuck-tx").value, say);
        msg.style.color = "#7ddc8a";
      } catch (err) {
        fail(err);
      } finally {
        goTx.disabled = false;
      }
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountFinishPanel);
  else mountFinishPanel();
})();
