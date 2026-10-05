import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  PACKET_SENT_TOPIC,
  JOB_ASSIGNED_TOPIC,
  decodePacket,
  innerRelayHash,
  signIfMatches,
  packetFromReceipt,
  assignmentsFromReceipt,
  signLockTransaction,
  accountFromSecret,
  chainIdForEid,
  verifierForEid,
} from "../src/sign.js";
import worker from "../src/index.js";

function word(n, bytes) {
  return BigInt(n).toString(16).padStart(bytes * 2, "0");
}

function buildPacket({ nonce = 7n, srcEid = 30324, dstEid = 30184, sender, receiver, message = "0x1234" }) {
  const guid = `0x${"ab".repeat(32)}`;
  const s = sender.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const r = receiver.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  return (
    "0x01" +
    word(nonce, 8) +
    word(srcEid, 4) +
    s +
    word(dstEid, 4) +
    r +
    guid.slice(2) +
    message.replace(/^0x/i, "")
  );
}

function encodePacketSentData(encodedPacket) {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }, { type: "address" }],
    [encodedPacket, "0x0003", "0x1111111111111111111111111111111111111111"],
  );
}

function encodeJobAssignedData(dstEid, payloadHash, sender) {
  return encodeAbiParameters(
    [{ type: "uint32" }, { type: "bytes32" }, { type: "uint64" }, { type: "address" }],
    [dstEid, payloadHash, 20n, sender],
  );
}

const vault = "0xe81DdAB112137112B8FeeB853e22BC4c38F999e5";
const minter = "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f";
const endpoint = "0x5c6cfF4b7C49805F8295Ff73C204ac83f3bC4AE7";
const sourceDvn = "0xa101a956712cca75ef10de23f832509708daef1e";

{
  const packet = buildPacket({ sender: vault, receiver: minter });
  const decoded = decodePacket(packet);
  assert.equal(decoded.srcEid, 30324);
  assert.equal(decoded.dstEid, 30184);
  assert.equal(decoded.sender.toLowerCase(), vault.toLowerCase());
  assert.equal(decoded.receiver.toLowerCase(), minter.toLowerCase());
  assert.equal(decoded.header.length, 2 + 81 * 2);
}

{
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const packet = buildPacket({ sender: vault, receiver: minter });
  const decoded = decodePacket(packet);
  await assert.rejects(
    () => signIfMatches({ encodedPacket: packet, recordedHash: `0x${"11".repeat(32)}`, account }),
    /does not match/,
  );
  await assert.rejects(
    () => signIfMatches({ encodedPacket: packet, recordedHash: decoded.payloadHash, account }),
    /signer key does not match/,
  );
}

{
  function loadConfiguredSignerPk() {
    let raw = process.env.BRIDGE_RELAY_SIGNER_PK || "";
    if (!raw) {
      try {
        const line = readFileSync("/home/box/.bridge/relay-signer", "utf8")
          .split("\n")
          .find((row) => row.startsWith("BRIDGE_RELAY_SIGNER_PK="));
        raw = line ? line.slice("BRIDGE_RELAY_SIGNER_PK=".length).trim() : "";
      } catch {
        raw = "";
      }
    }
    if (!raw) throw new Error("BRIDGE_RELAY_SIGNER_PK missing for configured-signer tests");
    if (/^[0-9a-fA-F]{64}$/.test(raw)) raw = `0x${raw}`;
    return raw;
  }
  const pk = loadConfiguredSignerPk();
  const account = accountFromSecret(pk);
  const packet = buildPacket({ sender: vault, receiver: minter });
  const decoded = decodePacket(packet);
  const signed = await signIfMatches({ encodedPacket: packet, recordedHash: decoded.payloadHash, account });
  assert.equal(signed.signer.toLowerCase(), account.address.toLowerCase());
  assert.ok(signed.signature.startsWith("0x"));
  assert.equal(JSON.stringify(signed).toLowerCase().includes(pk.slice(2).toLowerCase()), false);
}

{
  const cfg = JSON.parse(readFileSync(new URL("../../../docs/dvn.json", import.meta.url), "utf8"));
  assert.equal(chainIdForEid(30184), 8453);
  assert.equal(verifierForEid(30184).toLowerCase(), cfg.byEid["30184"].toLowerCase());
  assert.ok(cfg.signRelayUrl.includes("sign-relay"));
}

{
  const packet = buildPacket({
    nonce: 7n,
    srcEid: 30324,
    dstEid: 30101,
    sender: vault,
    receiver: "0xDd3E6cc04168bCFC1ACaE5e70748618C5b38092B",
  });
  const decoded = decodePacket(packet);
  const expectedInner = keccak256(
    encodeAbiParameters(
      [{ type: "uint32" }, { type: "uint32" }, { type: "bytes32" }],
      [30324, 30101, decoded.payloadHash],
    ),
  );
  assert.equal(innerRelayHash(30324, 30101, decoded.payloadHash), expectedInner);
}

{
  const packet = buildPacket({ sender: vault, receiver: minter });
  const decoded = decodePacket(packet);
  const receipt = {
    logs: [
      {
        address: endpoint,
        topics: [PACKET_SENT_TOPIC],
        data: encodePacketSentData(packet),
      },
      {
        address: sourceDvn,
        topics: [JOB_ASSIGNED_TOPIC],
        data: encodeJobAssignedData(30184, decoded.payloadHash, vault),
      },
    ],
  };
  const found = packetFromReceipt(receipt, endpoint);
  assert.ok(found);
  assert.equal(found.packet.payloadHash, decoded.payloadHash);
  const jobs = assignmentsFromReceipt(receipt);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].dstEid, 30184);
  assert.equal(jobs[0].payloadHash, decoded.payloadHash);

  function loadConfiguredSignerPk() {
    let raw = process.env.BRIDGE_RELAY_SIGNER_PK || "";
    if (!raw) {
      try {
        const line = readFileSync("/home/box/.bridge/relay-signer", "utf8")
          .split("\n")
          .find((row) => row.startsWith("BRIDGE_RELAY_SIGNER_PK="));
        raw = line ? line.slice("BRIDGE_RELAY_SIGNER_PK=".length).trim() : "";
      } catch {
        raw = "";
      }
    }
    if (!raw) throw new Error("BRIDGE_RELAY_SIGNER_PK missing for mock-rpc tests");
    if (/^[0-9a-fA-F]{64}$/.test(raw)) raw = `0x${raw}`;
    return raw;
  }
  const goodPk = loadConfiguredSignerPk();
  const badPk = generatePrivateKey();

  let bodyCalls = 0;
  const fetchImpl = async (_url, init) => {
    const req = JSON.parse(init.body);
    bodyCalls += 1;
    if (req.method === "eth_getTransactionReceipt") {
      return {
        ok: true,
        async json() {
          return {
            jsonrpc: "2.0",
            id: 1,
            result: {
              transactionHash: req.params[0],
              status: "0x1",
              logs: receipt.logs.map((l) => ({
                address: l.address,
                topics: l.topics,
                data: l.data,
                blockNumber: "0x1",
                transactionHash: req.params[0],
                logIndex: "0x0",
              })),
            },
          };
        },
      };
    }
    if (req.method === "eth_call") {
      return {
        ok: true,
        async json() {
          return { jsonrpc: "2.0", id: 1, result: decoded.payloadHash };
        },
      };
    }
    return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: null }; } };
  };

  await assert.rejects(
    () =>
      signLockTransaction({
        txHash: `0x${"11".repeat(32)}`,
        srcChainId: 2741,
        privateKey: badPk,
        fetchImpl,
      }),
    /signer key does not match/,
  );

  const ok = await signLockTransaction({
    txHash: `0x${"11".repeat(32)}`,
    srcChainId: 2741,
    privateKey: goodPk,
    fetchImpl,
  });
  assert.equal(ok.dstChainId, 8453);
  assert.equal(ok.verifier.toLowerCase(), verifierForEid(30184).toLowerCase());
  assert.ok(ok.encodedPacket.startsWith("0x"));
  assert.ok(ok.signature.startsWith("0x"));
  assert.ok(bodyCalls >= 1);

  const fetchBad = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === "eth_getTransactionReceipt") return fetchImpl(_url, init);
    if (req.method === "eth_call") {
      return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: `0x${"00".repeat(32)}` }; } };
    }
    return { ok: true, async json() { return { jsonrpc: "2.0", id: 1, result: null }; } };
  };
  await assert.rejects(
    () =>
      signLockTransaction({
        txHash: `0x${"22".repeat(32)}`,
        srcChainId: 2741,
        privateKey: goodPk,
        fetchImpl: fetchBad,
      }),
    /did not record|does not match/,
  );
}

{
  // HTTP handler: reject GET, bad origin, missing fields; OPTIONS CORS.
  const env = { BRIDGE_RELAY_SIGNER_PK: generatePrivateKey() };
  const get = await worker.fetch(new Request("https://bridge-sign-relay.workers.dev/api/sign-relay", { method: "GET" }), env);
  assert.equal(get.status, 405);

  const badOrigin = await worker.fetch(
    new Request("https://bridge-sign-relay.workers.dev/api/sign-relay", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ txHash: `0x${"33".repeat(32)}`, srcChainId: 2741 }),
    }),
    env,
  );
  assert.equal(badOrigin.status, 403);

  const options = await worker.fetch(
    new Request("https://bridge-sign-relay.workers.dev/api/sign-relay", {
      method: "OPTIONS",
      headers: { origin: "https://bridge.bigfoot404.biz" },
    }),
    env,
  );
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "https://bridge.bigfoot404.biz");

  const missing = await worker.fetch(
    new Request("https://bridge-sign-relay.workers.dev/api/sign-relay", {
      method: "POST",
      headers: { origin: "http://localhost:5173", "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(missing.status, 400);
}

// Optional live check when a real lock exists on the new verifiers.
if (process.env.SIGN_RELAY_LIVE_TX && process.env.BRIDGE_RELAY_SIGNER_PK) {
  const live = await signLockTransaction({
    txHash: process.env.SIGN_RELAY_LIVE_TX,
    srcChainId: Number(process.env.SIGN_RELAY_LIVE_SRC || 2741),
    privateKey: process.env.BRIDGE_RELAY_SIGNER_PK,
  });
  assert.ok(live.signature);
  assert.ok(live.verifier);
  assert.ok(live.dstChainId);
  console.log("live sign-relay ok dstChainId", live.dstChainId);
}

console.log("sign-relay worker tests passed");
