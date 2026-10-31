/* Bitcoin Ordinals destination (MAINNET, pilot). Add-on like deliver.js; no dependencies.
   Adds a "₿ Bitcoin Ordinals" chip to "2 · Destination" and a receiving Taproot (bc1p…) field.
   Submit = real Abstract vault lock (prepayPush + safeTransferFrom, same calls as the main flow) → POST
   { dest:'ordinals', recipient, lockTxHash, ... } to the ordinals-delivery service, which verifies the lock on
   Abstract and inscribes the Ordinal. Gated: nothing is locked unless BRIDGE_ORDINALS_URL and
   BRIDGE_ORDINALS_LOCK_EID are both set. Network: window.BRIDGE_ORDINALS_NETWORK ("mainnet" default | "signet"). No Phantom. */
(function () {
  var ORDINALS = {
    mainnet: (window.BRIDGE_ORDINALS_NETWORK || "mainnet") === "mainnet",
    network: window.BRIDGE_ORDINALS_NETWORK === "signet" ? "signet" : "mainnet",
    deliveryUrl: (window.BRIDGE_ORDINALS_URL || ""), // empty until the service is hosted → submit disabled
    // Ordinals route = OrdinalsSink on Arbitrum One (LayerZero eid 30110; receive-only, mints nothing).
    // Disabled until BRIDGE_ORDINALS_SINK is set to the deployed sink (and the vault owner ran setPeer(30110, sink)).
    sink: /^0x[0-9a-fA-F]{40}$/.test(window.BRIDGE_ORDINALS_SINK || "") ? window.BRIDGE_ORDINALS_SINK : "",
    lockEid: Number(window.BRIDGE_ORDINALS_LOCK_EID || (/^0x[0-9a-fA-F]{40}$/.test(window.BRIDGE_ORDINALS_SINK || "") ? 30110 : 0)),
    vault: "0xe81DdAB112137112B8FeeB853e22BC4c38F999e5", // Abstract NftLockVault (same as the main bundle)
    lzOptions: window.BRIDGE_ORDINALS_LZ_OPTIONS || "0x00030100110100000000000000000000000000030d40",
  };
  ORDINALS.explorer = ORDINALS.network === "mainnet" ? "https://mempool.space" : "https://mempool.space/signet";
  window.bridgeOrdinalsConfig = ORDINALS;

  // ---- bech32 / bech32m (BIP-173/350) ----
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function polymod(v) {
    var chk = 1;
    for (var i = 0; i < v.length; i++) {
      var b = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v[i];
      for (var j = 0; j < 5; j++) if ((b >>> j) & 1) chk ^= GEN[j];
    }
    return chk >>> 0;
  }
  function decodeSegwit(addr) {
    if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
    var a = addr.toLowerCase(), pos = a.lastIndexOf("1");
    if (pos < 1 || pos + 7 > a.length || a.length > 90) return null;
    var hrp = a.slice(0, pos), data = [], ex = [], i;
    for (i = 0; i < hrp.length; i++) ex.push(hrp.charCodeAt(i) >> 5);
    ex.push(0);
    for (i = 0; i < hrp.length; i++) ex.push(hrp.charCodeAt(i) & 31);
    for (i = pos + 1; i < a.length; i++) { var d = CHARSET.indexOf(a[i]); if (d < 0) return null; data.push(d); }
    var chk = polymod(ex.concat(data)), m = chk === 0x2bc830a3;
    if (chk !== 1 && !m) return null;
    var ver = data[0], acc = 0, bits = 0, prog = [];
    var body = data.slice(1, -6);
    for (i = 0; i < body.length; i++) { acc = (acc << 5) | body[i]; bits += 5; if (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 255); } }
    if (bits >= 5 || ((acc << (8 - bits)) & 255)) return null;
    if (prog.length < 2 || prog.length > 40 || ver > 16) return null;
    if ((ver === 0) === m) return null;
    return { hrp: hrp, version: ver, program: prog };
  }
  function check(raw) {
    var a = (raw || "").trim(), want = ORDINALS.network === "mainnet" ? "bc" : "tb";
    if (!a) return { ok: false, level: "", msg: "" };
    var d = decodeSegwit(a);
    if (!d) return /^[13mn2]/.test(a)
      ? { ok: false, level: "warn", msg: "Legacy / P2SH address. Ordinals need a Taproot (" + want + "1p…) address." }
      : { ok: false, level: "error", msg: "Not a valid Bitcoin address." };
    if (d.hrp !== "bc" && d.hrp !== "tb") return { ok: false, level: "error", msg: "Not a Bitcoin address." };
    if (!(d.version === 1 && d.program.length === 32)) return { ok: false, level: "warn",
      msg: d.version === 0 ? "SegWit " + d.hrp + "1q… address. Ordinals can be lost here — use your wallet's Taproot (" + want + "1p…) ordinals address." : "Unsupported witness version. Use a Taproot address." };
    if (d.hrp !== want) return d.hrp === "bc"
      ? { ok: false, level: "warn", msg: "Mainnet address. This build delivers on signet — use a tb1p… address." }
      : { ok: false, level: "warn", msg: "Testnet/signet address — not accepted. Use your mainnet Taproot (bc1p…) ordinals address." };
    return { ok: true, level: "ok", msg: "Valid " + ORDINALS.network + " Taproot address." };
  }
  window.bridgeCheckOrdinalsAddress = check;

  // ---- BTC wallets (no Phantom) ----
  function wallets() {
    var w = window, out = [];
    if (w.unisat) out.push("unisat");
    if (w.okxwallet && w.okxwallet.bitcoin) out.push("okx");
    if ((w.XverseProviders && w.XverseProviders.BitcoinProvider) || w.BitcoinProvider) out.push("xverse");
    if (w.magicEden && w.magicEden.bitcoin) out.push("magiceden");
    if (w.LeatherProvider) out.push("leather");
    return out;
  }
  function pickTaproot(list) {
    for (var i = 0; i < (list || []).length; i++) {
      var s = typeof list[i] === "string" ? list[i] : list[i] && list[i].address;
      if (typeof s === "string" && /^(bc|tb)1p/i.test(s)) return s;
    }
    return "";
  }
  async function readWallet(id) {
    var w = window, r;
    if (id === "unisat") return pickTaproot(await w.unisat.requestAccounts());
    if (id === "okx") { r = await w.okxwallet.bitcoin.connect(); return pickTaproot([r && r.address]); }
    if (id === "magiceden") { r = await w.magicEden.bitcoin.request({ method: "getAccounts", params: { purposes: ["ordinals"] } }); return pickTaproot((r && (r.result || r)) || []); }
    if (id === "xverse") { var p = (w.XverseProviders && w.XverseProviders.BitcoinProvider) || w.BitcoinProvider; r = await p.request("getAccounts", { purposes: ["ordinals"], message: "Ordinals receiving address for Bridge.bigfoot404.biz" }); return pickTaproot((r && r.result) || []); }
    if (id === "leather") { r = await w.LeatherProvider.request("getAddresses"); return pickTaproot(((r && r.result && r.result.addresses) || []).filter(function (a) { return a.type === "p2tr"; })); }
    return "";
  }

  // ---- styles ----
  var css = document.createElement("style");
  css.textContent =
    ".chip-btc{white-space:nowrap;border-style:dashed}.chip-btc.ord-on{border-color:#f7931a;box-shadow:inset 0 0 0 1px #f7931a;color:#fff;background:#241a0d}" +
    "body.ord-mode .chip-row .chip.active:not(.chip-btc){color:var(--muted);border-color:#2c3532;background:#111;box-shadow:none}" +
    ".ord-field{margin-top:1rem}.ord-field label{display:block;color:var(--muted);font-size:.75rem;letter-spacing:.04em;margin-bottom:.35rem}" +
    ".ord-field label .muted{font-size:.7rem;letter-spacing:0}.ord-field input{width:100%;box-sizing:border-box}" +
    ".ord-field input[aria-invalid=true]{border-color:#f7b54a;box-shadow:none}" +
    ".pilot-badge{display:inline-block;margin-bottom:.55rem;padding:.2rem .6rem;border-radius:999px;border:1px dashed #f7931a;color:#f7931a;font-size:.7rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}" +
    ".addr-check{margin:.4rem 0 0;font-size:.78rem;line-height:1.35;overflow-wrap:anywhere}.addr-ok{color:var(--lime)}.addr-warn{color:#f7b54a}.addr-error{color:#ff6b6b}" +
    ".ord-field .btn-sm{margin-top:.5rem;padding:.4rem .8rem;font-size:.75rem}" +
    ".ord-box{margin-top:.6rem;font-size:.75rem;display:grid;gap:.25rem;overflow-wrap:anywhere}.ord-box span{color:var(--muted)}" +
    "body.ord-mode [data-ord-p3] > .hint,body.ord-mode [data-ord-p3] > .steps{display:none}.ord-note{display:none}body.ord-mode .ord-note{display:block}" +
    ".ord-status{margin-top:.75rem;font-size:.82rem;line-height:1.4;color:#f7b54a;overflow-wrap:anywhere}.ord-status.ok{color:var(--lime)}";
  document.head.appendChild(css);

  var state = { on: false, addr: "", busy: false, delivery: null };
  var field, chip, statusEl;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function panelByTitle(re) {
    var hs = document.querySelectorAll("section.panel h2");
    for (var i = 0; i < hs.length; i++) if (re.test(hs[i].textContent)) return hs[i].closest("section.panel");
    return null;
  }
  function selectedNft() {
    var card = document.querySelector(".nft-card.selected");
    if (!card) return null;
    var g = function (s) { var e = card.querySelector(s); return e ? e.textContent.trim() : ""; };
    var img = card.querySelector("img");
    // Card shows the collection name; resolve the contract from the page's "Collection: NAME · 0x22Fc…0A8A" line.
    var addr = "", m = /0x([0-9a-fA-F]{4})\S*?([0-9a-fA-F]{4})\b/.exec((document.body.textContent.match(/Collection:[^\n]*/) || [""])[0]);
    var known = [window.BRIDGE_ORDINALS_COLLECTION, "0x22Fc5BB9810Ef92db35acCea463693331bcD0A8A"];
    for (var i = 0; m && i < known.length; i++) if (known[i] && known[i].slice(2, 6).toLowerCase() === m[1].toLowerCase() && known[i].slice(-4).toLowerCase() === m[2].toLowerCase()) addr = known[i];
    return { name: g(".nft-meta strong"), collectionName: g(".nft-meta span"), collection: addr, tokenId: g(".token-id").replace(/^#/, ""), image: img ? img.src : "" };
  }
  function bridgeButton(panel) { return panel && panel.querySelector(".btn-primary.btn-lg"); }

  function renderField() {
    var c = check(state.addr), ws = wallets();
    field.innerHTML =
      '<span class="pilot-badge">Pilot</span>' +
      '<label for="btc-recipient">Receiving BTC address (Ordinals)<span class="muted"> (' + (ORDINALS.network === "mainnet" ? "bc1p…" : "signet tb1p…") + " Taproot)</span></label>" +
      '<input id="btc-recipient" type="text" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="' + (ORDINALS.network === "mainnet" ? "bc1p…" : "tb1p… (signet)") + '" aria-invalid="' + (!!state.addr && !c.ok) + '" value="' + esc(state.addr) + '">' +
      (c.msg ? '<p class="addr-check addr-' + c.level + '">' + esc(c.msg) + "</p>" : "") +
      (ws.length ? '<button type="button" class="btn btn-ghost btn-sm" data-ord-wallet="' + ws[0] + '">Use connected BTC wallet (' + ws[0] + ")</button>" : "") +
      '<p class="hint">Only use a Taproot / Ordinals-capable wallet (Xverse, UniSat, Leather, OKX, Magic Eden). Your NFT is locked in the Abstract vault and inscribed as an Ordinal on Bitcoin.</p>' +
      (state.est ? '<p class="hint ord-est">Est. Bitcoin inscription cost: <b>~$' + Number(state.est.usd).toFixed(2) + "</b> (" + esc(state.est.sats) + " sats at " + esc(state.est.feeRate) + " sat/vB, " + esc(state.est.mode) + " mode). " + (state.est.underCap ? "Under the $" + esc(state.est.marginUsd) + " limit." : "Above the $" + esc(state.est.marginUsd) + " limit right now: delivery would wait for lower Bitcoin fees.") + "</p>" : "") +
      (state.delivery ? '<div class="ord-box"><div><span>Delivery</span> <code>' + esc(state.delivery.id) + "</code> · <b>" + esc(state.delivery.status === "queued" ? "Waiting for lower Bitcoin fees" : state.delivery.status) + "</b></div>" +
        (state.delivery.commitTxid ? '<div><span>commit</span> <a target="_blank" rel="noreferrer" href="' + ORDINALS.explorer + "/tx/" + esc(state.delivery.commitTxid) + '"><code>' + esc(state.delivery.commitTxid) + "</code></a></div>" : "") +
        (state.delivery.revealTxid ? '<div><span>reveal</span> <a target="_blank" rel="noreferrer" href="' + ORDINALS.explorer + "/tx/" + esc(state.delivery.revealTxid) + '"><code>' + esc(state.delivery.revealTxid) + "</code></a></div>" : "") + "</div>" : "");
    var inp = field.querySelector("input");
    inp.addEventListener("input", function () {
      var pos = inp.selectionStart; state.addr = inp.value; renderField();
      var n = field.querySelector("input"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {}
    });
    var wb = field.querySelector("[data-ord-wallet]");
    if (wb) wb.addEventListener("click", async function () {
      try { var a = await readWallet(wb.getAttribute("data-ord-wallet")); if (a) { state.addr = a; renderField(); } else setStatus("No Taproot (ordinals) address returned by the wallet."); }
      catch (e) { setStatus(e && e.message ? e.message : String(e)); }
    });
    syncButton();
  }
  function setStatus(msg, ok) {
    var p = panelByTitle(/^3 ·/); if (!p) return;
    if (!statusEl || !p.contains(statusEl)) { statusEl = document.createElement("p"); statusEl.className = "ord-status"; p.appendChild(statusEl); }
    statusEl.className = "ord-status" + (ok ? " ok" : ""); statusEl.textContent = msg || "";
  }
  function syncButton() {
    var b = bridgeButton(panelByTitle(/^3 ·/));
    if (!b) return;
    if (state.on) {
      if (!b.dataset.ordLabel) b.dataset.ordLabel = b.textContent;
      var g = gate();
      var lbl = state.busy ? "Working…" : (g || "Bridge to Ordinals");
      if (b.textContent !== lbl) b.textContent = lbl;
      var blk = (g || !check(state.addr).ok || !selectedNft()) ? "1" : "";
      if (b.dataset.ordBlocked !== blk) { b.dataset.ordBlocked = blk; b.style.opacity = blk ? "0.55" : ""; }
      if (b.disabled !== !!g) b.disabled = !!g;
    } else if (b.dataset.ordLabel) {
      b.textContent = b.dataset.ordLabel; delete b.dataset.ordLabel; b.style.opacity = ""; b.dataset.ordBlocked = ""; b.disabled = false;
    }
  }
  function setOn(on) {
    state.on = on;
    document.body.classList.toggle("ord-mode", on);
    if (chip) chip.classList.toggle("ord-on", on);
    if (field) field.style.display = on ? "" : "none";
    if (!on) setStatus(""); else loadEstimate();
    syncButton();
  }

  /** Live USD estimate (GET /api/ordinals/estimate) for the active mode, shown BEFORE the user locks. */
  async function loadEstimate() {
    if (!ORDINALS.deliveryUrl) return null;
    try {
      var e = await fetch(ORDINALS.deliveryUrl + "/api/ordinals/estimate").then(function (r) { return r.json(); });
      var m = e[e.mode === "metadata" ? "metadataOnly" : e.mode] || e.image;
      state.est = { usd: m.usd, sats: m.sats, underCap: m.underCap, feeRate: e.feeRate, mode: e.mode, marginUsd: e.marginUsd };
      if (field) renderField();
      return state.est;
    } catch (x) { return null; }
  }
  window.bridgeOrdinalsEstimate = loadEstimate;

  /** Why Ordinals submit is blocked BEFORE any lock ('' = ready). */
  function gate() {
    if (!ORDINALS.deliveryUrl) return "Delivery service not live yet";
    if (!ORDINALS.lockEid || !ORDINALS.sink) return "Ordinals lock path not live yet";
    return "";
  }
  window.bridgeOrdinalsGate = gate;

  // ---- keccak-256 (Ethereum) and the bc1p commitment used as the lock's EVM recipient ----
  // recipient = low 20 bytes of keccak256("BIGFOOT404-ORDINALS-V1:" + lowercase bc1p) — same as
  // OrdinalsSink.ordinalsRecipient and ordinals-delivery ordinalsCommitment. No key exists for it; it binds the address.
  var RC = [1,0,32898,0,32906,2147483648,2147516416,2147483648,32907,0,2147483649,0,2147516545,2147483648,32777,2147483648,138,0,136,0,2147516425,0,2147483658,0,2147516555,0,139,2147483648,32905,2147483648,32771,2147483648,32770,2147483648,128,2147483648,32778,0,2147483658,2147483648,2147516545,2147483648,32896,2147483648,2147483649,0,2147516424,2147483648];
  function keccakF(s) {
    var c = new Array(10), b = new Array(50), h, l, n, x, y;
    for (n = 0; n < 48; n += 2) {
      for (x = 0; x < 10; x++) c[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
      for (x = 0; x < 10; x += 2) {
        var x1 = (x + 2) % 10, x4 = (x + 8) % 10;
        h = c[x4] ^ ((c[x1] << 1) | (c[x1 + 1] >>> 31)); l = c[x4 + 1] ^ ((c[x1 + 1] << 1) | (c[x1] >>> 31));
        for (y = 0; y < 50; y += 10) { s[y + x] ^= h; s[y + x + 1] ^= l; }
      }
      // rho + pi
      for (x = 0; x < 5; x++) for (y = 0; y < 5; y++) {
        var i = 2 * (x + 5 * y), r = ROT[x + 5 * y], j = 2 * (y + 5 * ((2 * x + 3 * y) % 5)), lo = s[i], hi = s[i + 1];
        if (r >= 32) { var t = lo; lo = hi; hi = t; r -= 32; }
        b[j] = r ? ((lo << r) | (hi >>> (32 - r))) : lo; b[j + 1] = r ? ((hi << r) | (lo >>> (32 - r))) : hi;
      }
      for (y = 0; y < 50; y += 10) for (x = 0; x < 10; x++) s[y + x] = b[y + x] ^ (~b[y + (x + 2) % 10] & b[y + (x + 4) % 10]);
      s[0] ^= RC[n]; s[1] ^= RC[n + 1];
    }
  }
  var ROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
  function keccak256(bytes) {
    var s = new Array(50).fill(0), rate = 136, p = bytes.slice(), i, k;
    p.push(1); while (p.length % rate) p.push(0); p[p.length - 1] |= 0x80;
    for (k = 0; k < p.length; k += rate) {
      for (i = 0; i < rate / 4; i++) s[i] ^= p[k + 4 * i] | (p[k + 4 * i + 1] << 8) | (p[k + 4 * i + 2] << 16) | (p[k + 4 * i + 3] << 24);
      keccakF(s);
    }
    var out = "";
    for (i = 0; i < 8; i++) for (k = 0; k < 4; k++) out += ("0" + ((s[i] >>> (8 * k)) & 255).toString(16)).slice(-2);
    return out;
  }
  function ordinalsCommitment(btc) {
    var str = "BIGFOOT404-ORDINALS-V1:" + String(btc).trim().toLowerCase(), bytes = [];
    for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 255); // bech32 is ASCII
    return "0x" + keccak256(bytes).slice(24);
  }
  window.bridgeOrdinalsCommitment = ordinalsCommitment;

  // ---- Abstract lock (EIP-1193, same vault calls as the main bundle: quoteLock → prepayPush → safeTransferFrom) ----
  var h64 = function (x) { return String(x).replace(/^0x/, "").toLowerCase().padStart(64, "0"); };
  var big = function (n) { return BigInt(n).toString(16); };
  function encBytes(hex) { var d = hex.replace(/^0x/, ""); return h64(big(d.length / 2)) + d.padEnd(Math.ceil(d.length / 64) * 64, "0"); }
  function provider() {
    var p = window.ethereum; if (!p || !p.request) throw new Error("Connect an Abstract (EVM) wallet first.");
    return p;
  }
  async function waitTx(p, hash) {
    for (var i = 0; i < 120; i++) {
      var r = await p.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (r) { if (r.status !== "0x1") throw new Error("Abstract tx reverted: " + hash); return r; }
      await new Promise(function (res) { setTimeout(res, 2000); });
    }
    throw new Error("Timed out waiting for " + hash);
  }
  async function lockOnAbstract(nft, btc) {
    var p = provider();
    var from = (await p.request({ method: "eth_requestAccounts" }))[0];
    if (parseInt(await p.request({ method: "eth_chainId" }), 16) !== 2741) throw new Error("Switch your wallet to Abstract first.");
    // Recipient is the bc1p commitment, not the wallet: the lock itself proves which Taproot address gets the Ordinal.
    var opts = ORDINALS.lzOptions, me = h64(ordinalsCommitment(btc)), eid = h64(big(ORDINALS.lockEid));
    // quoteLock(address,uint256,uint32,address,bytes)
    var q = await p.request({ method: "eth_call", params: [{ to: ORDINALS.vault, data: "0x8b31251e" + h64(nft.collection) + h64(big(nft.tokenId)) + eid + me + h64("a0") + encBytes(opts) }, "latest"] });
    var fee = BigInt("0x" + q.slice(2, 66)) * 11n / 10n;
    setStatus("Step 1/3: pay the bridge fee in your wallet…");
    var t1 = await p.request({ method: "eth_sendTransaction", params: [{ from: from, to: ORDINALS.vault, value: "0x" + fee.toString(16), data: "0x8101dad6" + h64(nft.collection) + h64(big(nft.tokenId)) }] });
    await waitTx(p, t1);
    setStatus("Step 2/3: lock the NFT in the vault (confirm in your wallet)…");
    // data = abi.encode(uint32 destEid, bytes32 recipient, bool solana=false, bytes options)
    var data = eid + me + h64("0") + h64("80") + encBytes(opts);
    var t2 = await p.request({ method: "eth_sendTransaction", params: [{ from: from, to: nft.collection,
      data: "0xb88d4fde" + h64(from) + h64(ORDINALS.vault) + h64(big(nft.tokenId)) + h64("80") + encBytes("0x" + data) }] });
    await waitTx(p, t2);
    return t2;
  }

  async function submit() {
    var nft = selectedNft(), c = check(state.addr), g = gate();
    if (g) return setStatus(g + " — nothing was locked and no Ordinal was inscribed.");
    if (!nft) return setStatus("Select an NFT above first.");
    if (!c.ok) return setStatus(c.msg || "Enter a receiving BTC address (Ordinals).");
    if (!/^0x[0-9a-fA-F]{40}$/.test(nft.collection || "")) return setStatus("Could not read this NFT's contract address. Nothing was locked.");
    state.busy = true; syncButton();
    var req;
    try {
      // Service must be reachable BEFORE the NFT is locked.
      var hr = await fetch(ORDINALS.deliveryUrl + "/api/ordinals/health").then(function (r) { return r.json(); }).catch(function () { return null; });
      if (!hr || !hr.ok || hr.network !== ORDINALS.network) throw new Error("Delivery service is not reachable right now. Nothing was locked.");
      if (hr.mode === "recursive" && hr.setup && !Object.keys(hr.setup).some(function (k) { return hr.setup[k] === "inscribed"; })) throw new Error("Collection setup not inscribed on Bitcoin yet. Nothing was locked.");
      var est = await loadEstimate();
      if (est) setStatus("Est. Bitcoin cost ~$" + Number(est.usd).toFixed(2) + (est.underCap ? "" : " — above the limit now, your Ordinal will wait for lower Bitcoin fees") + ". Confirm the lock in your wallet…");
      var lockTx = await lockOnAbstract(nft, state.addr.trim());
      req = { dest: "ordinals", network: ORDINALS.network, recipient: state.addr.trim(), collection: nft.collection, tokenId: nft.tokenId,
        tokenURI: "", image: nft.image, name: nft.name, lockTxHash: lockTx, srcChainId: 2741 };
      window.bridgeOrdinalsLastRequest = req;
      setStatus("Step 3/3: lock confirmed (" + lockTx.slice(0, 10) + "…). Requesting the Ordinal…");
      var d;
      for (var a = 0; a < 40; a++) { // the service needs the lock to reach its confirmation depth (HTTP 425)
        var r = await fetch(ORDINALS.deliveryUrl + "/api/ordinals/deliveries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
        d = await r.json().catch(function () { return {}; });
        if (r.status !== 425) { if (!r.ok) throw new Error((d.error || "Delivery service error " + r.status) + " Your lock tx: " + lockTx); break; }
        setStatus("Waiting for Abstract confirmations on " + lockTx.slice(0, 10) + "…");
        await new Promise(function (res) { setTimeout(res, 5000); });
      }
      state.delivery = d; renderField();
      for (var i = 0; i < 360 && d.status !== "delivered" && d.status !== "failed"; i++) {
        setStatus(d.status === "queued" ? (d.waiting || "Waiting for lower Bitcoin fees") + (d.estUsd != null ? " (now ~$" + d.estUsd + ")" : "") + ". Your NFT is safely locked; we retry automatically." : (d.waiting ? d.waiting : "Ordinal delivery " + d.status + "…"));
        await new Promise(function (res) { setTimeout(res, 10000); });
        d = await (await fetch(ORDINALS.deliveryUrl + "/api/ordinals/deliveries/" + encodeURIComponent(d.id))).json();
        state.delivery = d; renderField();
      }
      if (d.status === "failed") throw new Error((d.error || "Delivery failed") + " Your lock tx: " + lockTx);
      setStatus(d.status === "delivered" ? "Ordinal delivered: " + d.inscriptionId : "Ordinal " + d.status + " — check the links above.", d.status === "delivered");
    } catch (e) {
      setStatus((e && e.message ? e.message : String(e)));
    } finally { state.busy = false; syncButton(); }
  }

  // Intercept the main bridge button while Ordinals is selected (capture phase, before React).
  document.addEventListener("click", function (ev) {
    if (!state.on) return;
    var t = ev.target && ev.target.closest && ev.target.closest("button");
    if (!t) return;
    var p = panelByTitle(/^3 ·/);
    if (p && t === bridgeButton(p)) { ev.preventDefault(); ev.stopPropagation(); if (!state.busy) submit(); return; }
    var destPanel = panelByTitle(/^2 ·/);
    if (destPanel && t.classList.contains("chip") && t !== chip && destPanel.contains(t)) setOn(false);
    if (t.classList.contains("nft-card")) setTimeout(syncButton, 0);
  }, true);

  function mount() {
    var p = panelByTitle(/^2 · Destination/);
    var lockMode = !!panelByTitle(/^3 · Bridge/);
    if (!p || !lockMode) { if (state.on && !lockMode) setOn(false); if (chip && !lockMode) chip.style.display = "none"; return; }
    var row = p.querySelector(".chip-row");
    if (!row) return;
    if (!chip || !row.contains(chip)) {
      chip = document.createElement("button");
      chip.type = "button"; chip.className = "chip chip-btc"; chip.textContent = "₿ Bitcoin Ordinals";
      chip.addEventListener("click", function () { setOn(true); });
      row.appendChild(chip);
    }
    chip.style.display = "";
    chip.classList.toggle("ord-on", state.on);
    if (!field || !p.contains(field)) {
      field = document.createElement("div"); field.className = "ord-field";
      var hint = p.querySelector(".hint");
      if (hint) hint.insertAdjacentElement("afterend", field); else p.appendChild(field);
      renderField();
    }
    field.style.display = state.on ? "" : "none";
    var p3 = panelByTitle(/^3 · Bridge/);
    if (p3 && !p3.hasAttribute("data-ord-p3")) p3.setAttribute("data-ord-p3", "");
    if (p3 && !p3.querySelector(".ord-note")) {
      var note = document.createElement("p"); note.className = "hint ord-note";
      note.textContent = "Pilot: your NFT is locked in the Abstract vault, then the delivery service verifies the lock and inscribes the NFT image + metadata as an Ordinal on Bitcoin (commit → reveal), sent to your Taproot address.";
      var h2 = p3.querySelector("h2"); if (h2) h2.insertAdjacentElement("afterend", note);
    }
    syncButton();
  }
  new MutationObserver(function () { mount(); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", mount);
})();
