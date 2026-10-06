/**
 * One-shot mint signature.
 *
 * A lock already called assignJob on the source ExecutorDVN and emitted PacketSent.
 * This script reads that one transaction, checks the recorded payload hash matches the
 * packet, signs (srcEid, dstEid, payloadHash), prints the signature, and exits.
 * It does not send a transaction and it does not poll.
 *
 * The private key is BRIDGE_RELAY_SIGNER_PK, or the same variable in
 * /home/box/.bridge/relay-signer (outside the repo). Never print the key.
 *
 *   node script/signRelay.mjs --tx 0xLOCKTX --src-chain 2741
 *
 * The bridge page POSTs { txHash, srcChainId } to /api/sign-relay. GitHub Pages cannot
 * hold this key. Wherever the site runs, that route should call signLockTransaction
 * and return the JSON this script prints. Do not leave a process running.
 */
import { AbiCoder, Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getBytes, id, keccak256, verifyMessage } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { decodePacket } from "./ownerDvnWorker.mjs";

export const SIGNER_FILE = "/home/box/.bridge/relay-signer";
export const PACKET_SENT_TOPIC = id("PacketSent(bytes,bytes,address)");
export const JOB_ASSIGNED_TOPIC = id("JobAssigned(uint32,bytes32,uint64,address)");

const JOB_ASSIGNED = ["event JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender)"];
const PACKET_HASH_ABI = ["function packetHash(bytes32 headerHash) view returns (bytes32)"];

export const SOURCES = {
  2741: { rpc: ["https://api.mainnet.abs.xyz"], endpoint: "0x5c6cfF4b7C49805F8295Ff73C204ac83f3bC4AE7" },
  1: { rpc: ["https://ethereum.publicnode.com", "https://ethereum.reth.rs/rpc"], endpoint: "0x1a44076050125825900e736c501f859c50fE728c" },
  8453: { rpc: ["https://mainnet.base.org"], endpoint: "0x1a44076050125825900e736c501f859c50fE728c" },
  56: { rpc: ["https://bsc.publicnode.com", "https://bsc-dataseed.binance.org"], endpoint: "0x1a44076050125825900e736c501f859c50fE728c" },
  33139: { rpc: ["https://rpc.apechain.com/http"], endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B" },
  4663: { rpc: ["https://rpc.mainnet.chain.robinhood.com"], endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B" },
};

const coder = AbiCoder.defaultAbiCoder();
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function loadSignerWallet() {
  let raw = process.env.BRIDGE_RELAY_SIGNER_PK || "";
  if (!raw && existsSync(SIGNER_FILE)) {
    const line = readFileSync(SIGNER_FILE, "utf8")
      .split("\n")
      .find((row) => row.startsWith("BRIDGE_RELAY_SIGNER_PK="));
    raw = line ? line.slice("BRIDGE_RELAY_SIGNER_PK=".length).trim() : "";
  }
  if (!raw) throw new Error("BRIDGE_RELAY_SIGNER_PK is not set");
  if (/^[0-9a-fA-F]{64}$/.test(raw)) raw = `0x${raw}`;
  return new Wallet(raw);
}

export function innerRelayHash(srcEid, dstEid, payloadHash) {
  return keccak256(coder.encode(["uint32", "uint32", "bytes32"], [srcEid, dstEid, payloadHash]));
}

/** Sign only when the assignJob record equals the packet's payload hash. */
export async function signIfMatches({ encodedPacket, recordedHash, wallet }) {
  const packet = decodePacket(encodedPacket);
  if (!recordedHash || /^0x0+$/i.test(recordedHash)) {
    throw new Error("source assignJob did not record this packet");
  }
  if (!eq(recordedHash, packet.payloadHash)) {
    throw new Error("payload hash does not match the assignJob record");
  }
  const signature = await wallet.signMessage(getBytes(innerRelayHash(packet.srcEid, packet.dstEid, packet.payloadHash)));
  const signer = wallet.address;
  const recovered = verifyMessage(getBytes(innerRelayHash(packet.srcEid, packet.dstEid, packet.payloadHash)), signature);
  if (!eq(recovered, signer)) throw new Error("signature did not recover to the signer");
  return {
    signer,
    signature,
    encodedPacket: typeof encodedPacket === "string" ? encodedPacket : encodedPacket,
    srcEid: packet.srcEid,
    dstEid: packet.dstEid,
    payloadHash: packet.payloadHash,
    nonce: packet.nonce.toString(),
    receiver: packet.receiver,
  };
}

function providerFor(url, chainId) {
  const req = new FetchRequest(url);
  req.timeout = 20_000;
  return new JsonRpcProvider(req, chainId, { staticNetwork: true });
}

async function withSource(chainId, fn) {
  const src = SOURCES[Number(chainId)];
  if (!src) throw new Error(`unsupported source chain ${chainId}`);
  let last;
  for (const url of src.rpc) {
    try {
      return await fn(providerFor(url, Number(chainId)), src);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

export function packetsFromReceipt(receipt, endpoint) {
  const out = [];
  for (const entry of receipt.logs || []) {
    if (endpoint && !eq(entry.address, endpoint)) continue;
    if (!entry.topics?.length || !eq(entry.topics[0], PACKET_SENT_TOPIC)) continue;
    const [encodedPacket] = coder.decode(["bytes", "bytes", "address"], entry.data);
    out.push({ encodedPacket, packet: decodePacket(encodedPacket) });
  }
  return out;
}

export function packetFromReceipt(receipt, endpoint, packetIndex = 0) {
  const all = packetsFromReceipt(receipt, endpoint);
  if (!all.length) return null;
  const idx = Number(packetIndex) || 0;
  if (idx < 0 || idx >= all.length) throw new Error(`packetIndex ${idx} out of range (found ${all.length})`);
  return all[idx];
}

export function assignmentsFromReceipt(receipt) {
  const iface = new Interface(JOB_ASSIGNED);
  const out = [];
  for (const entry of receipt.logs || []) {
    if (!entry.topics?.length || !eq(entry.topics[0], JOB_ASSIGNED_TOPIC)) continue;
    const parsed = iface.decodeEventLog("JobAssigned", entry.data, entry.topics);
    out.push({
      address: entry.address,
      dstEid: Number(parsed.dstEid),
      payloadHash: parsed.payloadHash,
      sender: parsed.sender,
    });
  }
  return out;
}

async function recordedHash(provider, dvn, header) {
  const contract = new Contract(dvn, PACKET_HASH_ABI, provider);
  return contract.packetHash(keccak256(getBytes(header)));
}

export async function signLockTransaction({ txHash, srcChainId, wallet, packetIndex = 0 }) {
  return withSource(srcChainId, async (provider, src) => {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error("transaction receipt not found");
    const found = packetFromReceipt(receipt, src.endpoint, packetIndex);
    if (!found) throw new Error("PacketSent was not in that transaction");
    const jobs = assignmentsFromReceipt(receipt).filter(
      (job) => job.dstEid === found.packet.dstEid && eq(job.payloadHash, found.packet.payloadHash),
    );
    if (jobs.length === 0) throw new Error("assignJob did not emit a matching payload hash");
    let recorded = "0x" + "00".repeat(32);
    let matched = false;
    for (const job of jobs) {
      try {
        recorded = await recordedHash(provider, job.address, found.packet.header);
      } catch {
        continue;
      }
      if (eq(recorded, found.packet.payloadHash)) {
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error("payload hash does not match the assignJob record");
    const signed = await signIfMatches({
      encodedPacket: found.encodedPacket,
      recordedHash: recorded,
      wallet: wallet || loadSignerWallet(),
    });
    signed.txHash = txHash;
    signed.srcChainId = Number(srcChainId);
    return signed;
  });
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? "" : process.argv[i + 1] || "";
}

const isMain = process.argv[1] && process.argv[1].endsWith("signRelay.mjs");
if (isMain) {
  const tx = arg("--tx");
  const srcChain = arg("--src-chain");
  const encoded = arg("--encoded-packet");
  const recorded = arg("--recorded-hash");
  const run = async () => {
    const wallet = loadSignerWallet();
    if (tx) {
      if (!srcChain) throw new Error("--src-chain is required with --tx");
      return signLockTransaction({ txHash: tx, srcChainId: Number(srcChain), wallet });
    }
    if (encoded) {
      if (!recorded) throw new Error("--recorded-hash is required with --encoded-packet");
      return signIfMatches({ encodedPacket: encoded, recordedHash: recorded, wallet });
    }
    throw new Error("pass --tx and --src-chain, or --encoded-packet and --recorded-hash");
  };
  run()
    .then((out) => {
      process.stdout.write(`${JSON.stringify(out)}\n`);
    })
    .catch((err) => {
      const text = String(err && err.message ? err.message : err).replace(/0x[a-fA-F0-9]{64}/g, "0x…");
      process.stderr.write(`${text}\n`);
      process.exit(1);
    });
}
