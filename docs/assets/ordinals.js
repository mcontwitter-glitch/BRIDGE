/* Bitcoin Ordinals destination (SIGNET TEST / pilot). Add-on like deliver.js; no dependencies.
   Adds a "₿ Bitcoin Ordinals" chip to "2 · Destination", a receiving Taproot address field,
   and sends { dest:'ordinals', recipient, ... } to the ordinals-delivery service.
   ORDINALS.mainnet === false hard-blocks mainnet. While mainnet is off the Abstract NFT is NOT locked
   (no mainnet tx); the service inscribes on Bitcoin signet. No Phantom. */
(function () {
  var ORDINALS = {
    mainnet: false,
    network: "signet",
    deliveryUrl: (window.BRIDGE_ORDINALS_URL || ""), // empty until a host is approved → UI shows "Coming soon / pilot"
    explorer: "https://mempool.space/signet",
  };
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
      ? { ok: false, level: "warn", msg: "Mainnet Taproot address. Mainnet delivery is not approved yet — this is a signet test. Use a signet tb1p… address." }
      : { ok: false, level: "warn", msg: "Testnet/signet address. Use a mainnet bc1p… address." };
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
    return { name: g(".nft-meta strong"), collection: g(".nft-meta span"), tokenId: g(".token-id").replace(/^#/, ""), image: img ? img.src : "" };
  }
  function bridgeButton(panel) { return panel && panel.querySelector(".btn-primary.btn-lg"); }

  function renderField() {
    var c = check(state.addr), ws = wallets();
    field.innerHTML =
      '<span class="pilot-badge">Coming soon / pilot · signet test</span>' +
      '<label for="btc-recipient">Receiving BTC address (Ordinals)<span class="muted"> (' + (ORDINALS.network === "mainnet" ? "bc1p…" : "signet tb1p…") + " Taproot)</span></label>" +
      '<input id="btc-recipient" type="text" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="' + (ORDINALS.network === "mainnet" ? "bc1p…" : "tb1p… (signet)") + '" aria-invalid="' + (!!state.addr && !c.ok) + '" value="' + esc(state.addr) + '">' +
      (c.msg ? '<p class="addr-check addr-' + c.level + '">' + esc(c.msg) + "</p>" : "") +
      (ws.length ? '<button type="button" class="btn btn-ghost btn-sm" data-ord-wallet="' + ws[0] + '">Use connected BTC wallet (' + ws[0] + ")</button>" : "") +
      '<p class="hint">Only use a Taproot / Ordinals-capable wallet (Xverse, UniSat, Leather, OKX, Magic Eden). Signet test: the NFT is not locked on mainnet and the Ordinal is inscribed on Bitcoin signet, not mainnet.</p>' +
      (state.delivery ? '<div class="ord-box"><div><span>Delivery</span> <code>' + esc(state.delivery.id) + "</code> · <b>" + esc(state.delivery.status) + "</b></div>" +
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
      var lbl = state.busy ? "Working…" : "Bridge to Ordinals (signet test)";
      if (b.textContent !== lbl) b.textContent = lbl;
      var blk = (!check(state.addr).ok || !selectedNft()) ? "1" : "";
      if (b.dataset.ordBlocked !== blk) { b.dataset.ordBlocked = blk; b.style.opacity = blk ? "0.55" : ""; }
    } else if (b.dataset.ordLabel) {
      b.textContent = b.dataset.ordLabel; delete b.dataset.ordLabel; b.style.opacity = ""; b.dataset.ordBlocked = "";
    }
  }
  function setOn(on) {
    state.on = on;
    document.body.classList.toggle("ord-mode", on);
    if (chip) chip.classList.toggle("ord-on", on);
    if (field) field.style.display = on ? "" : "none";
    if (!on) setStatus("");
    syncButton();
  }

  async function submit() {
    var nft = selectedNft(), c = check(state.addr);
    if (!nft) return setStatus("Select an NFT above first.");
    if (!c.ok) return setStatus(c.msg || "Enter a receiving BTC address (Ordinals).");
    if (ORDINALS.network === "mainnet" && !ORDINALS.mainnet) return setStatus("Mainnet Ordinals delivery is disabled.");
    var req = { dest: "ordinals", network: ORDINALS.network, recipient: state.addr.trim(), collection: nft.collection, tokenId: nft.tokenId,
      tokenURI: "", image: nft.image, name: nft.name, lockTxHash: "0xsignettest" + Date.now().toString(16), lockId: nft.collection + "-" + nft.tokenId + "-ordinals", srcChainId: 2741, test: true };
    window.bridgeOrdinalsLastRequest = req;
    if (!ORDINALS.deliveryUrl) return setStatus("Coming soon / pilot — the Ordinals delivery service is not hosted yet (signet test). No request was sent and no Ordinal was inscribed.");
    state.busy = true; syncButton(); setStatus("Signet test: sending delivery request…");
    try {
      var r = await fetch(ORDINALS.deliveryUrl + "/api/ordinals/deliveries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || "Delivery service error " + r.status);
      state.delivery = d; renderField();
      for (var i = 0; i < 180 && d.status !== "delivered" && d.status !== "failed"; i++) {
        setStatus("Signet test delivery " + d.status + "…");
        await new Promise(function (res) { setTimeout(res, 5000); });
        d = await (await fetch(ORDINALS.deliveryUrl + "/api/ordinals/deliveries/" + encodeURIComponent(d.id))).json();
        state.delivery = d; renderField();
      }
      if (d.status === "failed") throw new Error(d.error || "Delivery failed");
      setStatus(d.status === "delivered" ? "Signet test Ordinal delivered: " + d.inscriptionId : "Signet test delivery " + d.status + ".", d.status === "delivered");
    } catch (e) {
      setStatus("Coming soon / pilot — " + (e && e.message ? e.message : String(e)) + " No Ordinal was inscribed.");
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
      note.textContent = "Signet test: no Abstract lock is sent. The delivery service inscribes the NFT image + metadata as an Ordinal on Bitcoin signet (commit → reveal) and sends it to your Taproot address.";
      var h2 = p3.querySelector("h2"); if (h2) h2.insertAdjacentElement("afterend", note);
    }
    syncButton();
  }
  new MutationObserver(function () { mount(); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", mount);
})();
