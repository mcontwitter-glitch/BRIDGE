/**
 * One-shot mint signature for Cloudflare Workers (viem).
 * Same checks as script/signRelay.mjs. Never print the private key.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBytes,
  keccak256,
  parseAbiItem,
  recoverMessageAddress,
  toBytes,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import config from "./config.js";

export const PACKET_SENT_TOPIC = keccak256(toBytes("PacketSent(bytes,bytes,address)"));
export const JOB_ASSIGNED_TOPIC = keccak256(toBytes("JobAssigned(uint32,bytes32,uint64,address)"));
export const HEADER_LEN = 81;

const PACKET_HASH_ABI = [
  {
    type: "function",
    name: "packetHash",
    stateMutability: "view",
    inputs: [{ name: "headerHash", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
];

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function chainById(srcChainId) {
  const key = String(Number(srcChainId));
  const chain = config.chains?.[key];
  if (!chain) throw new Error(`unsupported source chain ${srcChainId}`);
  return { chainId: Number(key), ...chain };
}

export function chainIdForEid(eid) {
  const want = Number(eid);
  for (const [id, chain] of Object.entries(config.chains || {})) {
    if (Number(chain.eid) === want) return Number(id);
  }
  throw new Error(`no chain id for eid ${eid}`);
}

export function verifierForEid(eid) {
  const v = config.byEid?.[String(Number(eid))];
  if (!v) throw new Error(`no verifier for eid ${eid}`);
  return getAddress(v);
}

export function decodePacket(encodedPacket) {
  const bytes = hexToBytes(/** @type {`0x${string}`} */ (encodedPacket));
  if (bytes.length < 113) throw new Error("packet shorter than header + guid");
  if (bytes[0] !== 1) throw new Error("unsupported packet version");
  const readUint = (off, len) => {
    let n = 0n;
    for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(bytes[off + i]);
    return n;
  };
  const header = toHex(bytes.slice(0, HEADER_LEN));
  const payloadBytes = bytes.slice(HEADER_LEN);
  const sender = toHex(bytes.slice(13 + 12, 45));
  const receiver = toHex(bytes.slice(49 + 12, 81));
  return {
    header,
    payloadHash: keccak256(payloadBytes),
    nonce: readUint(1, 8),
    srcEid: Number(readUint(9, 4)),
    sender: getAddress(sender),
    dstEid: Number(readUint(45, 4)),
    receiver: getAddress(receiver),
    guid: toHex(bytes.slice(81, 113)),
    message: toHex(bytes.slice(113)),
  };
}

export function innerRelayHash(srcEid, dstEid, payloadHash) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint32" }, { type: "uint32" }, { type: "bytes32" }],
      [Number(srcEid), Number(dstEid), /** @type {`0x${string}`} */ (payloadHash)],
    ),
  );
}

export function normalizePrivateKey(raw) {
  let key = String(raw || "").trim();
  if (!key) throw new Error("BRIDGE_RELAY_SIGNER_PK is not set");
  if (/^[0-9a-fA-F]{64}$/.test(key)) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("BRIDGE_RELAY_SIGNER_PK is not a 32-byte hex key");
  return /** @type {`0x${string}`} */ (key);
}

export function accountFromSecret(raw) {
  return privateKeyToAccount(normalizePrivateKey(raw));
}

/** Sign only when the assignJob record equals the packet's payload hash. */
export async function signIfMatches({ encodedPacket, recordedHash, account }) {
  const packet = decodePacket(encodedPacket);
  if (!recordedHash || /^0x0+$/i.test(recordedHash)) {
    throw new Error("source assignJob did not record this packet");
  }
  if (!eq(recordedHash, packet.payloadHash)) {
    throw new Error("payload hash does not match the assignJob record");
  }
  const inner = innerRelayHash(packet.srcEid, packet.dstEid, packet.payloadHash);
  const signature = await account.signMessage({ message: { raw: hexToBytes(inner) } });
  const recovered = await recoverMessageAddress({ message: { raw: hexToBytes(inner) }, signature });
  if (!eq(recovered, account.address)) throw new Error("signature did not recover to the signer");
  if (config.signer && !eq(recovered, config.signer)) {
    throw new Error("signer key does not match the configured verifier signer");
  }
  return {
    signer: account.address,
    signature,
    encodedPacket: /** @type {`0x${string}`} */ (encodedPacket),
    srcEid: packet.srcEid,
    dstEid: packet.dstEid,
    payloadHash: packet.payloadHash,
    nonce: packet.nonce.toString(),
    receiver: packet.receiver,
  };
}

export function packetsFromReceipt(receipt, endpoint) {
  const out = [];
  for (const entry of receipt.logs || []) {
    if (endpoint && !eq(entry.address, endpoint)) continue;
    const topic0 = entry.topics?.[0];
    if (!topic0 || !eq(topic0, PACKET_SENT_TOPIC)) continue;
    const [encodedPacket] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes" }, { type: "address" }],
      /** @type {`0x${string}`} */ (entry.data),
    );
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
  const out = [];
  for (const entry of receipt.logs || []) {
    const topic0 = entry.topics?.[0];
    if (!topic0 || !eq(topic0, JOB_ASSIGNED_TOPIC)) continue;
    // JobAssigned(uint32 dstEid, bytes32 payloadHash, uint64 confirmations, address sender) — all non-indexed
    const [dstEid, payloadHash, , sender] = decodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes32" }, { type: "uint64" }, { type: "address" }],
      /** @type {`0x${string}`} */ (entry.data),
    );
    out.push({
      address: getAddress(entry.address),
      dstEid: Number(dstEid),
      payloadHash,
      sender: getAddress(sender),
    });
  }
  return out;
}

function transportFromUrls(urls, fetchImpl) {
  let lastErr;
  return custom({
    async request({ method, params }) {
      lastErr = undefined;
      for (const url of urls) {
        try {
          const res = await (fetchImpl || fetch)(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          if (!res.ok) {
            lastErr = new Error(`rpc HTTP ${res.status}`);
            continue;
          }
          const body = await res.json();
          if (body.error) {
            lastErr = new Error(body.error.message || "rpc error");
            continue;
          }
          return body.result;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("all rpcs failed");
    },
  });
}

export function createSourceClient(srcChainId, fetchImpl) {
  const src = chainById(srcChainId);
  return {
    src,
    client: createPublicClient({
      transport: transportFromUrls(src.rpc, fetchImpl),
    }),
  };
}

async function recordedHash(client, dvn, header) {
  return client.readContract({
    address: getAddress(dvn),
    abi: PACKET_HASH_ABI,
    functionName: "packetHash",
    args: [keccak256(hexToBytes(/** @type {`0x${string}`} */ (header)))],
  });
}

/**
 * @param {{ txHash: string, srcChainId: number|string, privateKey: string, packetIndex?: number, fetchImpl?: typeof fetch }} args
 */
export async function signLockTransaction({ txHash, srcChainId, privateKey, packetIndex = 0, fetchImpl }) {
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
  const account = accountFromSecret(privateKey);
  const { src, client } = createSourceClient(srcChainId, fetchImpl);
  const receipt = await client.getTransactionReceipt({ hash: /** @type {`0x${string}`} */ (txHash) });
  if (!receipt) throw new Error("transaction receipt not found");
  const found = packetFromReceipt(receipt, src.endpoint, packetIndex);
  if (!found) throw new Error("PacketSent was not in that transaction");
  const jobs = assignmentsFromReceipt(receipt).filter(
    (job) => job.dstEid === found.packet.dstEid && eq(job.payloadHash, found.packet.payloadHash),
  );
  if (jobs.length === 0) throw new Error("assignJob did not emit a matching payload hash");
  let recorded = /** @type {`0x${string}`} */ (`0x${"00".repeat(32)}`);
  let matched = false;
  for (const job of jobs) {
    try {
      recorded = /** @type {`0x${string}`} */ (await recordedHash(client, job.address, found.packet.header));
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
    account,
  });
  const dstChainId = chainIdForEid(signed.dstEid);
  const verifier = verifierForEid(signed.dstEid);
  return {
    encodedPacket: signed.encodedPacket,
    signature: signed.signature,
    dstChainId,
    verifier,
    // extras for debugging / UI; safe (no key)
    srcEid: signed.srcEid,
    dstEid: signed.dstEid,
    payloadHash: signed.payloadHash,
    signer: signed.signer,
    txHash,
    srcChainId: Number(srcChainId),
    packetIndex: Number(packetIndex) || 0,
  };
}

export { config, encodePacked, encodeFunctionData, parseAbiItem, createWalletClient };
