import { Wallet, getBytes, verifyMessage, keccak256, AbiCoder } from "ethers";
import { decodePacket } from "./ownerDvnWorker.mjs";
import { innerRelayHash, signIfMatches } from "./signRelay.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const wallet = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const nonce = 7n;
const srcEid = 30324;
const dstEid = 30101;
const sender = "0xe81ddab112137112b8feeb853e22bc4c38f999e5";
const receiver = "0xdd3e6cc04168bcfc1acae5e70748618c5b38092b";
const guid = "0x" + "ab".repeat(32);
const message = "0x1234";
const word = (n, bytes) => BigInt(n).toString(16).padStart(bytes * 2, "0");
const encoded =
  "0x01" +
  word(nonce, 8) +
  word(srcEid, 4) +
  sender.slice(2).padStart(64, "0") +
  word(dstEid, 4) +
  receiver.slice(2).padStart(64, "0") +
  guid.slice(2) +
  message.slice(2);
const packet = decodePacket(encoded);
const inner = innerRelayHash(packet.srcEid, packet.dstEid, packet.payloadHash);
const expected = keccak256(
  AbiCoder.defaultAbiCoder().encode(["uint32", "uint32", "bytes32"], [srcEid, dstEid, packet.payloadHash]),
);
assert(inner === expected, "inner hash is keccak of srcEid, dstEid, payloadHash");

let threw = false;
try {
  await signIfMatches({ encodedPacket: encoded, recordedHash: "0x" + "11".repeat(32), wallet });
} catch (err) {
  threw = /does not match/.test(err.message);
}
assert(threw, "mismatched assignJob record must refuse to sign");

const signed = await signIfMatches({ encodedPacket: encoded, recordedHash: packet.payloadHash, wallet });
assert(signed.signer.toLowerCase() === wallet.address.toLowerCase(), "reports signer address");
assert(!JSON.stringify(signed).includes("59c6995e998f97a5"), "result does not contain the private key");
const recovered = verifyMessage(getBytes(inner), signed.signature);
assert(recovered.toLowerCase() === wallet.address.toLowerCase(), "signature recovers to the signer");

console.log("signRelay tests passed");
