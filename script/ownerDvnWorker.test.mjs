import { JsonRpcProvider } from "ethers";
import {
  OWNER,
  encodeVerifyCalldata,
  encodeCommitCalldata,
  encodeLzReceiveCalldata,
  decodePacket,
  decodeUlnConfig,
  isProtectedApeNonce,
  processPacket,
} from "./ownerDvnWorker.mjs";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const header = "0x" + "01" + "00".repeat(80);
const payloadHash = "0x" + "11".repeat(32);
const verifyData = encodeVerifyCalldata(header, payloadHash, 20);
assert(verifyData.startsWith("0x0223536e"), `verify selector ${verifyData.slice(0, 10)}`);
assert(verifyData.length > 10 + 64 * 2, "verify calldata has header, hash, and confirmations");

const commitData = encodeCommitCalldata(header, payloadHash);
assert(commitData.startsWith("0x0894edf1"), `commit selector ${commitData.slice(0, 10)}`);

const lzData = encodeLzReceiveCalldata({
  srcEid: 30324,
  sender: "0xe81DdAB112137112B8FeeB853e22BC4c38F999e5",
  nonce: 1n,
  receiver: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
  guid: "0x" + "22".repeat(32),
  message: "0xabcdef",
});
assert(lzData.startsWith("0x" ) && lzData.includes("abcdef"), "lzReceive calldata encodes the message");
assert(lzData.length > 200, "lzReceive calldata is not empty");

const ulnHex =
  "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000100000000000000000000000065b7c47ddecc27bf8f7b26ee46c794e33219c8890000000000000000000000000000000000000000000000000000000000000000";
const cfg = decodeUlnConfig(ulnHex);
assert(cfg.confirmations === 15, `confirmations ${cfg.confirmations}`);
assert(cfg.requiredDVNs[0].toLowerCase() === "0x65b7c47ddecc27bf8f7b26ee46c794e33219c889", "required dvn");

const nonce = 7n;
const srcEid = 30324;
const dstEid = 30101;
const sender = "0xe81ddab112137112b8feeb853e22bc4c38f999e5";
const receiver = "0xdd3e6cc04168bcfc1acae5e70748618c5b38092b";
const guid = "0x" + "ab".repeat(32);
const message = "0x1234";
function word(n, bytes) {
  return BigInt(n).toString(16).padStart(bytes * 2, "0");
}
const encoded =
  "0x01" +
  word(nonce, 8) +
  word(srcEid, 4) +
  sender.slice(2).padStart(64, "0") +
  word(dstEid, 4) +
  receiver.slice(2).padStart(64, "0") +
  guid.slice(2) +
  message.slice(2);
const decoded = decodePacket(encoded);
assert(decoded.nonce === nonce, "nonce");
assert(decoded.srcEid === srcEid && decoded.dstEid === dstEid, "eids");
assert(decoded.sender.toLowerCase() === sender, "sender");
assert(decoded.receiver.toLowerCase() === receiver, "receiver");
assert(decoded.guid.toLowerCase() === guid, "guid");
assert(decoded.message.toLowerCase() === message, "message");
assert(decoded.header.length === 2 + 81 * 2, `header len ${decoded.header.length}`);
const again = encodeVerifyCalldata(decoded.header, decoded.payloadHash, 20);
assert(again.startsWith("0x0223536e"), "roundtrip verify selector");

assert(isProtectedApeNonce({ dstEid: 30312, nonce: 1n }), "ape nonce 1 protected");
assert(isProtectedApeNonce({ dstEid: 30312, nonce: 2 }), "ape nonce 2 protected");
assert(!isProtectedApeNonce({ dstEid: 30312, nonce: 3n }), "ape nonce 3 not protected");
assert(!isProtectedApeNonce({ dstEid: 30101, nonce: 1n }), "other chain nonce 1 not protected");

const ignored = await processPacket(
  { address: OWNER },
  { dstEid: 30312, nonce: "1", guid: "0x" + "01".repeat(32), sender: sender, receiver: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f" },
  { broadcast: true },
);
assert(ignored.status === "ignored-ape-nonce", `ape status ${ignored.status}`);

const ABS_TX = "0xa6b27334964ba683f63b9d3e662ddbe7d9ae7cb70bc4b9845cc5d3f4cbfe7ca7";
const provider = new JsonRpcProvider("https://api.mainnet.abs.xyz", 2741, { staticNetwork: true });
const receipt = await provider.getTransactionReceipt(ABS_TX);
assert(receipt, "abstract receipt");
const packetTopic = "0x1ab700d4ced0c005b164c0f789fd09fcbb0156d4c2041b8a3bfbcd961cd1567f";
const endpoint = "0x5c6cfF4b7C49805F8295Ff73C204ac83f3bC4AE7";
const { AbiCoder, keccak256, getBytes } = await import("ethers");
let live;
for (const entry of receipt.logs) {
  if (entry.address.toLowerCase() !== endpoint.toLowerCase()) continue;
  if (entry.topics[0].toLowerCase() !== packetTopic) continue;
  const [encodedPacket] = AbiCoder.defaultAbiCoder().decode(["bytes", "bytes", "address"], entry.data);
  live = decodePacket(encodedPacket);
  break;
}
assert(live, "PacketSent in lock tx");
assert(live.dstEid === 30312, `live dst ${live.dstEid}`);
assert(isProtectedApeNonce(live), "live ape packet is a skipped nonce");
const liveVerify = encodeVerifyCalldata(live.header, live.payloadHash, 20);
assert(liveVerify.startsWith("0x0223536e"), "live verify selector");
assert(keccak256(getBytes(live.header)) !== live.payloadHash, "header hash is not the payload hash");

const ape = new JsonRpcProvider("https://rpc.apechain.com/http", 33139, { staticNetwork: true });
const apeDvn = "0xce57de0119f9dd6cdf53a7696de252cafa4aee3d";
const sim = await ape.call({ from: OWNER, to: apeDvn, data: liveVerify });
assert(sim === "0x", `verify eth_call returned ${sim}`);
console.log("verify calldata encodes and eth_call on Ape OwnerDVN succeeded without a transaction");
console.log("skipped ape nonce", live.nonce.toString(), "was not broadcast");
console.log("ok");
