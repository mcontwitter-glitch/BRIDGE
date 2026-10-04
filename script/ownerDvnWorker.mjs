/**
 * Owner DVN worker.
 *
 * A lock (or unlock) already emits PacketSent inside the user's one transaction.
 * OwnerDVN.verify only forwards to the destination receive ULN. It does not
 * commitVerification and it does not lzReceive. Until those run, the twin stays unminted.
 *
 * This process, with BRIDGE_OWNER_PK:
 *   1. Watches MessageSent on the vault and each minter, and reads PacketSent
 *      from that same transaction (header + payload hash).
 *   2. Waits max(send, receive) ULN confirmations on the source chain.
 *   3. Calls destination OwnerDVN.verify(header, payloadHash, confirmations).
 *   4. Calls receiveUln.commitVerification (required; the DVN does not commit).
 *   5. If EndpointV2.inboundPayloadHash is still the payload hash, calls
 *      endpoint.lzReceive. If the LayerZero executor already cleared it, stop.
 *
 * Never changes DVN config. Never calls skip, nilify, burn, or clear.
 * ApeChain inbound nonces 1 and 2 were skipped and must stay skipped.
 *
 * Never print BRIDGE_OWNER_PK.
 */
import { AbiCoder, Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, id, keccak256, getBytes, hexlify, zeroPadValue } from "ethers";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export const OWNER = "0xb19F00e095B1387061d73751C772bbA848D196b1";
export const EMPTY_PAYLOAD_HASH = "0x" + "00".repeat(32);
export const NIL_PAYLOAD_HASH = "0x" + "ff".repeat(32);
export const HEADER_LEN = 81;
export const APE_EID = 30312;
export const APE_SKIPPED_NONCES = new Set([1n, 2n]);

const VERIFY_IFACE = new Interface(["function verify(bytes packetHeader, bytes32 payloadHash, uint64 confirmations)"]);
const COMMIT_IFACE = new Interface(["function commitVerification(bytes packetHeader, bytes32 payloadHash)"]);
const LZ_RECEIVE_IFACE = new Interface([
  "function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
]);
const PACKET_SENT_TOPIC = id("PacketSent(bytes,bytes,address)");
const MESSAGE_SENT_TOPIC = id("MessageSent(bytes32,uint32,bytes32)");
const MESSAGE_SENT = new Interface(["event MessageSent(bytes32 indexed lockId, uint32 destEid, bytes32 guid)"]);

const EP_ABI = [
  "function getSendLibrary(address sender, uint32 dstEid) view returns (address)",
  "function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)",
  "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
  "function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) view returns (bytes32)",
  "function lazyInboundNonce(address receiver, uint32 srcEid, bytes32 sender) view returns (uint64)",
];
const DVN_ABI = [
  "function owner() view returns (address)",
  "function receiveUln() view returns (address)",
  "function verify(bytes packetHeader, bytes32 payloadHash, uint64 confirmations)",
];
const ULN_ABI = [
  "function commitVerification(bytes packetHeader, bytes32 payloadHash)",
  "function hashLookup(bytes32 headerHash, bytes32 payloadHash, address dvn) view returns (bool submitted, uint64 confirmations)",
];
const OAPP_ABI = ["function endpoint() view returns (address)"];

export const CHAINS = [
  {
    key: "abstract",
    chainId: 2741,
    eid: 30324,
    rpc: ["https://api.mainnet.abs.xyz"],
    endpoint: "0x5c6cfF4b7C49805F8295Ff73C204ac83f3bC4AE7",
    oapp: "0xe81DdAB112137112B8FeeB853e22BC4c38F999e5",
    dvn: "0x65b7c47ddecc27bf8f7b26ee46c794e33219c889",
  },
  {
    key: "ethereum",
    chainId: 1,
    eid: 30101,
    rpc: ["https://ethereum.reth.rs/rpc", "https://eth.llamarpc.com", "https://rpc.ankr.com/eth"],
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    oapp: "0xDd3E6cc04168bCFC1ACaE5e70748618C5b38092B",
    dvn: "0x011c25b6ced570e01772e3c3f7217eee146106af",
  },
  {
    key: "base",
    chainId: 8453,
    eid: 30184,
    rpc: ["https://mainnet.base.org", "https://base.llamarpc.com"],
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    dvn: "0xdd3e6cc04168bcfc1acae5e70748618c5b38092b",
  },
  {
    key: "bnb",
    chainId: 56,
    eid: 30102,
    rpc: ["https://bsc.publicnode.com", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"],
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    dvn: "0xdd3e6cc04168bcfc1acae5e70748618c5b38092b",
  },
  {
    key: "apechain",
    chainId: 33139,
    eid: 30312,
    rpc: ["https://rpc.apechain.com/http"],
    endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    dvn: "0xce57de0119f9dd6cdf53a7696de252cafa4aee3d",
  },
  {
    key: "robinhood",
    chainId: 4663,
    eid: 30416,
    rpc: ["https://rpc.mainnet.chain.robinhood.com"],
    endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    dvn: "0xdd3e6cc04168bcfc1acae5e70748618c5b38092b",
  },
];

const TERMINAL = new Set([
  "executed",
  "executed-by-executor",
  "already-clear",
  "ignored-ape-nonce",
  "nil-untouched",
  "foreign",
]);

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function chainByEid(eid) {
  return CHAINS.find((c) => c.eid === Number(eid));
}

export function isProtectedApeNonce(packet) {
  return Number(packet.dstEid) === APE_EID && APE_SKIPPED_NONCES.has(BigInt(packet.nonce));
}

export function decodePacket(encodedPacket) {
  const bytes = getBytes(encodedPacket);
  if (bytes.length < 113) throw new Error("packet shorter than header + guid");
  if (bytes[0] !== 1) throw new Error("unsupported packet version");
  const headerBytes = bytes.slice(0, HEADER_LEN);
  const payloadBytes = bytes.slice(HEADER_LEN);
  const readUint = (off, len) => BigInt(hexlify(bytes.slice(off, off + len)));
  const sender = hexlify(bytes.slice(13 + 12, 45));
  const receiver = hexlify(bytes.slice(49 + 12, 81));
  return {
    header: hexlify(headerBytes),
    payloadHash: keccak256(payloadBytes),
    nonce: readUint(1, 8),
    srcEid: Number(readUint(9, 4)),
    sender,
    dstEid: Number(readUint(45, 4)),
    receiver,
    guid: hexlify(bytes.slice(81, 113)),
    message: hexlify(bytes.slice(113)),
  };
}

export function encodeVerifyCalldata(header, payloadHash, confirmations) {
  return VERIFY_IFACE.encodeFunctionData("verify", [header, payloadHash, confirmations]);
}

export function encodeCommitCalldata(header, payloadHash) {
  return COMMIT_IFACE.encodeFunctionData("commitVerification", [header, payloadHash]);
}

export function encodeLzReceiveCalldata(packet) {
  return LZ_RECEIVE_IFACE.encodeFunctionData("lzReceive", [
    {
      srcEid: packet.srcEid,
      sender: zeroPadValue(packet.sender, 32),
      nonce: packet.nonce,
    },
    packet.receiver,
    packet.guid,
    packet.message,
    "0x",
  ]);
}

export function decodeUlnConfig(configBytes) {
  const decoded = AbiCoder.defaultAbiCoder().decode(
    ["tuple(uint64,uint8,uint8,uint8,address[],address[])"],
    configBytes,
  )[0];
  const [confirmations, requiredDVNCount, optionalDVNCount, optionalDVNThreshold, requiredDVNs, optionalDVNs] = decoded;
  return {
    confirmations: Number(confirmations),
    requiredDVNCount: Number(requiredDVNCount),
    optionalDVNCount: Number(optionalDVNCount),
    optionalDVNThreshold: Number(optionalDVNThreshold),
    requiredDVNs,
    optionalDVNs,
  };
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
}

function shortErr(err) {
  const text = err?.shortMessage || err?.reason || err?.message || String(err);
  return text.replace(/0x[a-fA-F0-9]{64,}/g, "0x…").slice(0, 300);
}

function statePath() {
  return process.env.BRIDGE_WORKER_STATE || new URL("./.worker-state.json", import.meta.url).pathname;
}

function loadState() {
  const path = statePath();
  if (!existsSync(path)) return { cursors: {}, packets: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.cursors ||= {};
    parsed.packets ||= {};
    return parsed;
  } catch {
    return { cursors: {}, packets: {} };
  }
}

function saveState(state) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

function providerFor(url, chainId) {
  const req = new FetchRequest(url);
  req.timeout = 20_000;
  return new JsonRpcProvider(req, chainId, { staticNetwork: true });
}

async function withProvider(chain, fn) {
  let last;
  for (const url of chain.rpc) {
    try {
      const provider = providerFor(url, chain.chainId);
      return await fn(provider, url);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function isArchiveLimit(err) {
  const text = `${err?.shortMessage || ""} ${err?.message || ""} ${err?.info?.responseBody || ""}`.toLowerCase();
  return text.includes("archive") || text.includes("personal token") || text.includes("pruned");
}

async function getLogsChunked(provider, filter) {
  const from = filter.fromBlock;
  const to = filter.toBlock;
  try {
    return await provider.getLogs(filter);
  } catch (err) {
    if (isArchiveLimit(err) || to - from < 20) throw err;
    const mid = Math.floor((from + to) / 2);
    const left = await getLogsChunked(provider, { ...filter, toBlock: mid });
    const right = await getLogsChunked(provider, { ...filter, fromBlock: mid + 1 });
    return left.concat(right);
  }
}

function packetFromReceipt(receipt, endpoint) {
  for (const entry of receipt.logs) {
    if (!eq(entry.address, endpoint)) continue;
    if (!entry.topics?.length || !eq(entry.topics[0], PACKET_SENT_TOPIC)) continue;
    const [encodedPacket] = AbiCoder.defaultAbiCoder().decode(["bytes", "bytes", "address"], entry.data);
    return decodePacket(encodedPacket);
  }
  return null;
}

async function pathwayConfirmations(src, dst, packet) {
  return withProvider(src, async (srcProvider) => {
    return withProvider(dst, async (dstProvider) => {
      const srcEp = new Contract(src.endpoint, EP_ABI, srcProvider);
      const dstEp = new Contract(dst.endpoint, EP_ABI, dstProvider);
      const sendLib = await srcEp.getSendLibrary(packet.sender, packet.dstEid);
      const sendRaw = await srcEp.getConfig(packet.sender, sendLib, packet.dstEid, 2);
      const sendCfg = decodeUlnConfig(sendRaw);
      const recv = await dstEp.getReceiveLibrary(packet.receiver, packet.srcEid);
      const recvLib = recv[0] ?? recv.lib;
      const recvRaw = await dstEp.getConfig(packet.receiver, recvLib, packet.srcEid, 2);
      const recvCfg = decodeUlnConfig(recvRaw);
      const waitBlocks = Math.max(sendCfg.confirmations, recvCfg.confirmations);
      return { waitBlocks, verifyWith: waitBlocks, recvLib, sendCfg, recvCfg };
    });
  });
}

async function channelState(dst, packet) {
  return withProvider(dst, async (provider) => {
    const ep = new Contract(dst.endpoint, EP_ABI, provider);
    const sender = zeroPadValue(packet.sender, 32);
    const stored = await ep.inboundPayloadHash(packet.receiver, packet.srcEid, sender, packet.nonce);
    const lazy = await ep.lazyInboundNonce(packet.receiver, packet.srcEid, sender);
    return { provider, stored: String(stored), lazy: BigInt(lazy) };
  });
}

function mark(packet, status, extra) {
  packet.status = status;
  if (extra) Object.assign(packet, extra);
  packet.updatedAt = new Date().toISOString();
}

async function sendTx(chain, wallet, to, data, fallbackGas) {
  const bal = await wallet.provider.getBalance(wallet.address);
  const fee = await wallet.provider.getFeeData();
  let gasLimit = fallbackGas;
  try {
    const est = await wallet.estimateGas({ to, data });
    gasLimit = (est * 13n) / 10n + 40_000n;
  } catch {
    gasLimit = fallbackGas;
  }
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 1n;
  if (bal < gasLimit * price) {
    throw new Error(`insufficient gas on ${chain.key}`);
  }
  const nonce = await wallet.getNonce("pending");
  const req = { to, data, nonce, gasLimit, value: 0n };
  if (fee.maxFeePerGas) {
    req.maxFeePerGas = (fee.maxFeePerGas * 12n) / 10n;
    req.maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 1_000_000n;
    if (req.maxPriorityFeePerGas > req.maxFeePerGas) req.maxPriorityFeePerGas = req.maxFeePerGas;
  } else {
    req.gasPrice = ((fee.gasPrice ?? 1n) * 12n) / 10n;
  }
  const tx = await wallet.sendTransaction(req);
  const rec = await tx.wait();
  if (!rec || rec.status === 0) throw new Error(`tx reverted ${tx.hash}`);
  return tx.hash;
}

async function executeIfStillPending(dst, baseWallet, packet) {
  if (isProtectedApeNonce(packet)) {
    mark(packet, "ignored-ape-nonce");
    return;
  }
  const { provider, stored } = await channelState(dst, packet);
  if (eq(stored, NIL_PAYLOAD_HASH)) {
    mark(packet, "nil-untouched");
    return;
  }
  if (eq(stored, EMPTY_PAYLOAD_HASH)) {
    mark(packet, "executed-by-executor");
    return;
  }
  if (!eq(stored, packet.payloadHash)) {
    mark(packet, "hash-mismatch");
    return;
  }
  const data = encodeLzReceiveCalldata(packet);
  const wallet = baseWallet.connect(provider);
  try {
    await provider.call({ from: wallet.address, to: dst.endpoint, data });
  } catch (err) {
    const again = await channelState(dst, packet);
    if (eq(again.stored, EMPTY_PAYLOAD_HASH)) {
      mark(packet, "executed-by-executor");
      return;
    }
    mark(packet, "execute-sim-failed", { lastError: shortErr(err) });
    return;
  }
  const mid = await channelState(dst, packet);
  if (eq(mid.stored, EMPTY_PAYLOAD_HASH)) {
    mark(packet, "executed-by-executor");
    return;
  }
  if (!eq(mid.stored, packet.payloadHash) || isProtectedApeNonce(packet)) {
    mark(packet, isProtectedApeNonce(packet) ? "ignored-ape-nonce" : "hash-mismatch");
    return;
  }
  try {
    const hash = await sendTx(dst, wallet, dst.endpoint, data, 2_500_000n);
    log(`lzReceive ${dst.key} nonce ${packet.nonce} ${hash}`);
    mark(packet, "executed", { execTx: hash });
  } catch (err) {
    const again = await channelState(dst, packet);
    if (eq(again.stored, EMPTY_PAYLOAD_HASH)) {
      mark(packet, "executed-by-executor");
      return;
    }
    mark(packet, "execute-failed", { lastError: shortErr(err), nextTry: Date.now() + 60_000 });
    log(`lzReceive failed ${dst.key} nonce ${packet.nonce}: ${shortErr(err)}`);
  }
}

export async function processPacket(baseWallet, packet, { broadcast }) {
  if (isProtectedApeNonce(packet)) {
    mark(packet, "ignored-ape-nonce");
    log(`leave skipped Ape nonce ${packet.nonce} alone guid ${packet.guid}`);
    return packet;
  }
  const src = chainByEid(packet.srcEid);
  const dst = chainByEid(packet.dstEid);
  if (!src || !dst || !eq(packet.sender, src.oapp) || !eq(packet.receiver, dst.oapp)) {
    mark(packet, "foreign");
    return packet;
  }
  const now = Date.now();
  if (packet.nextTry && now < packet.nextTry) return packet;

  const { stored, lazy } = await channelState(dst, packet);
  if (eq(stored, NIL_PAYLOAD_HASH)) {
    mark(packet, "nil-untouched");
    return packet;
  }
  if (eq(stored, EMPTY_PAYLOAD_HASH) && BigInt(packet.nonce) <= lazy) {
    mark(packet, "already-clear");
    return packet;
  }
  if (eq(stored, packet.payloadHash)) {
    if (broadcast) await executeIfStillPending(dst, baseWallet, packet);
    else mark(packet, "ready-to-execute");
    return packet;
  }

  const conf = await pathwayConfirmations(src, dst, packet);
  const head = await withProvider(src, (p) => p.getBlockNumber());
  const readyAt = BigInt(packet.blockNumber) + BigInt(conf.waitBlocks);
  if (BigInt(head) < readyAt) {
    mark(packet, "waiting-confirmations", { waitBlocks: conf.waitBlocks, readyAt: readyAt.toString() });
    return packet;
  }

  const receiveUln = await withProvider(dst, async (provider) => {
    const dvn = new Contract(dst.dvn, DVN_ABI, provider);
    return dvn.receiveUln();
  });
  if (!eq(receiveUln, conf.recvLib)) {
    mark(packet, "uln-mismatch", { nextTry: Date.now() + 60_000 });
    log(`receive ULN mismatch on ${dst.key}; not sending and not changing config`);
    return packet;
  }

  const headerHash = keccak256(getBytes(packet.header));
  let submitted = false;
  let have = 0n;
  try {
    const looked = await withProvider(dst, (provider) => {
      const uln = new Contract(receiveUln, ULN_ABI, provider);
      return uln.hashLookup(headerHash, packet.payloadHash, dst.dvn);
    });
    submitted = Boolean(looked[0] ?? looked.submitted);
    have = BigInt(looked[1] ?? looked.confirmations ?? 0);
  } catch {
    submitted = false;
  }

  const verifyData = encodeVerifyCalldata(packet.header, packet.payloadHash, conf.verifyWith);
  const commitData = encodeCommitCalldata(packet.header, packet.payloadHash);
  if (!broadcast) {
    mark(packet, "dry-run", { verifyWith: conf.verifyWith, waitBlocks: conf.waitBlocks, verifyData, commitData });
    return packet;
  }

  const provider = await withProvider(dst, async (p) => p);
  const wallet = baseWallet.connect(provider);
  try {
    if (!(submitted && have >= BigInt(conf.verifyWith))) {
      const hash = await sendTx(dst, wallet, dst.dvn, verifyData, 450_000n);
      log(`verify ${dst.key} nonce ${packet.nonce} conf ${conf.verifyWith} ${hash}`);
      packet.verifyTx = hash;
    }
    await provider.call({ from: wallet.address, to: receiveUln, data: commitData });
    const commitHash = await sendTx(dst, wallet, receiveUln, commitData, 700_000n);
    log(`commitVerification ${dst.key} nonce ${packet.nonce} ${commitHash}`);
    packet.commitTx = commitHash;
    await executeIfStillPending(dst, baseWallet, packet);
  } catch (err) {
    mark(packet, packet.status && !TERMINAL.has(packet.status) ? packet.status : "retry", {
      lastError: shortErr(err),
      nextTry: Date.now() + 45_000,
    });
    if (packet.status === "retry" || packet.status === "waiting-confirmations") {
      packet.status = "retry";
    }
    log(`pathway ${src.key}->${dst.key} nonce ${packet.nonce}: ${shortErr(err)}`);
  }
  return packet;
}

async function discover(chain, state) {
  const lookback = Number(process.env.BRIDGE_LOOKBACK_BLOCKS || 300_000);
  await withProvider(chain, async (provider) => {
    const latest = await provider.getBlockNumber();
    const prev = state.cursors[chain.key];
    const fromBlock = prev ? Math.max(0, prev - 20) : Math.max(0, latest - lookback);
    if (fromBlock > latest) {
      state.cursors[chain.key] = latest;
      return;
    }
    const step = 8_000;
    let start = fromBlock;
    while (start <= latest) {
      let end = Math.min(latest, start + step - 1);
      let logs;
      try {
        logs = await getLogsChunked(provider, {
          address: chain.oapp,
          topics: [MESSAGE_SENT_TOPIC],
          fromBlock: start,
          toBlock: end,
        });
      } catch (err) {
        if (!isArchiveLimit(err)) throw err;
        const recent = Math.max(start, latest - 2_000);
        if (recent <= start) throw err;
        log(`scan ${chain.key} archive limit at block ${start}; continuing from ${recent}`);
        start = recent;
        continue;
      }
      for (const entry of logs) {
      let parsed;
      try {
        parsed = MESSAGE_SENT.parseLog(entry);
      } catch {
        continue;
      }
      const receipt = await provider.getTransactionReceipt(entry.transactionHash);
      if (!receipt) continue;
      const endpoint = chain.endpoint;
      const decoded = packetFromReceipt(receipt, endpoint);
      if (!decoded) {
        log(`MessageSent without PacketSent tx ${entry.transactionHash}`);
        continue;
      }
      if (!eq(decoded.guid, parsed.args.guid)) continue;
      if (!eq(decoded.sender, chain.oapp)) continue;
      const guid = decoded.guid;
      const existing = state.packets[guid];
      if (existing && TERMINAL.has(existing.status)) continue;
      state.packets[guid] = {
        ...(existing || {}),
        guid,
        srcEid: decoded.srcEid,
        dstEid: decoded.dstEid,
        nonce: decoded.nonce.toString(),
        sender: decoded.sender,
        receiver: decoded.receiver,
        header: decoded.header,
        payloadHash: decoded.payloadHash,
        message: decoded.message,
        blockNumber: entry.blockNumber,
        srcTx: entry.transactionHash,
        lockId: parsed.args.lockId,
        status: existing?.status || "discovered",
      };
      log(
        `packet ${chain.key} nonce ${decoded.nonce} -> eid ${decoded.dstEid} block ${entry.blockNumber} ${entry.transactionHash}`,
      );
      }
      state.cursors[chain.key] = end;
      start = end + 1;
    }
  });
}

export async function tick(baseWallet, state, { broadcast }) {
  for (const chain of CHAINS) {
    try {
      await discover(chain, state);
    } catch (err) {
      log(`scan ${chain.key} failed: ${shortErr(err)}`);
    }
  }
  for (const packet of Object.values(state.packets)) {
    if (TERMINAL.has(packet.status)) continue;
    try {
      await processPacket(baseWallet, packet, { broadcast });
    } catch (err) {
      packet.lastError = shortErr(err);
      packet.nextTry = Date.now() + 45_000;
      log(`process ${packet.guid} failed: ${packet.lastError}`);
    }
  }
  saveState(state);
}

async function assertOwners(wallet) {
  for (const chain of CHAINS) {
    try {
      await withProvider(chain, async (provider) => {
        const dvn = new Contract(chain.dvn, DVN_ABI, provider);
        const owner = await dvn.owner();
        const uln = await dvn.receiveUln();
        const oapp = new Contract(chain.oapp, OAPP_ABI, provider);
        const endpoint = await oapp.endpoint();
        if (!eq(owner, wallet.address)) throw new Error(`DVN owner is ${owner}`);
        if (!eq(endpoint, chain.endpoint)) {
          log(`endpoint mismatch ${chain.key} chain ${endpoint} config ${chain.endpoint}; using chain value`);
          chain.endpoint = endpoint;
        }
        log(`ready ${chain.key} dvn ${chain.dvn} receiveUln ${uln}`);
      });
    } catch (err) {
      log(`setup ${chain.key} failed: ${shortErr(err)}`);
    }
  }
}

async function main() {
  const raw = process.env.BRIDGE_OWNER_PK;
  if (!raw) {
    console.error("BRIDGE_OWNER_PK is not set");
    process.exit(1);
  }
  const wallet = new Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  if (!eq(wallet.address, OWNER)) {
    console.error("BRIDGE_OWNER_PK does not derive the expected owner");
    process.exit(1);
  }
  const broadcast = !process.argv.includes("--dry-run");
  log(`owner dvn worker ${wallet.address} broadcast=${broadcast}`);
  log("ApeChain nonces 1 and 2 are not verified, committed, or executed");
  await assertOwners(wallet);
  const state = loadState();
  if (!broadcast) {
    await tick(wallet, state, { broadcast: false });
    const summary = Object.values(state.packets).map((p) => ({
      guid: p.guid,
      nonce: p.nonce,
      dstEid: p.dstEid,
      status: p.status,
    }));
    console.log(JSON.stringify(summary));
    return;
  }
  const sleepMs = Number(process.env.BRIDGE_POLL_MS || 12_000);
  for (;;) {
    try {
      await tick(wallet, state, { broadcast: true });
    } catch (err) {
      log(`tick failed: ${shortErr(err)}`);
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith("ownerDvnWorker.mjs");
if (invoked) {
  main().catch((err) => {
    console.error(shortErr(err));
    process.exit(1);
  });
}
