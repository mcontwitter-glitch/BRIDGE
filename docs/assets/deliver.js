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
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + Number(opts.destChainId).toString(16) }],
      });
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
  var bridgeGuard = {
    checkFee: async function (o) {
      var cfg = await loadCfg();
      if (cfg.sendPaused) throw new Error(cfg.sendPausedReason || "Bridging is paused.");
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
})();
