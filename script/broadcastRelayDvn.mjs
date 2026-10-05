/**
 * Deploy ExecutorDVN and point the pathway at it.
 * Reads BRIDGE_OWNER_PK from the environment and never prints it.
 * One chain per invocation. Exits. Does not poll.
 *
 *   BRIDGE_RELAY_SIGNER=0x... node script/broadcastRelayDvn.mjs ethereum
 */
import { AbiCoder, Contract, ContractFactory, FetchRequest, JsonRpcProvider, Wallet, getCreateAddress } from "ethers";
import { readFileSync } from "node:fs";

const OWNER = "0xb19F00e095B1387061d73751C772bbA848D196b1";
const artifact = JSON.parse(readFileSync(new URL("../out/ExecutorDVN.sol/ExecutorDVN.json", import.meta.url), "utf8"));

const EP_ABI = [
  "function getSendLibrary(address sender, uint32 dstEid) view returns (address)",
  "function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)",
  "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
];
const OAPP_ABI = [
  "function endpoint() view returns (address)",
  "function setSendConfig(address sendLib, uint32 eid, uint64 confirmations, address dvn, uint32 maxMessageSize, address executor_)",
  "function setReceiveConfig(address receiveLib, uint32 eid, uint64 confirmations, address dvn)",
];
const DVN_ABI = ["function receiveUln() view returns (address)", "function signer() view returns (address)"];

const CHAINS = {
  abstract: {
    chainId: 2741,
    rpc: "https://api.mainnet.abs.xyz",
    oapp: "0xe81DdAB112137112B8FeeB853e22BC4c38F999e5",
    oldDvn: "0x565D9E3BA522de1090C645f372C2FF0Df67a9b42",
    executor: "0x643E1471f37c4680Df30cF0C540Cd379a0fF58A5",
    eids: [
      [30101, 20, 15],
      [30184, 20, 10],
      [30102, 20, 20],
      [30312, 20, 20],
      [30416, 20, 5],
    ],
  },
  ethereum: {
    chainId: 1,
    rpc: "https://ethereum.publicnode.com",
    oapp: "0xDd3E6cc04168bCFC1ACaE5e70748618C5b38092B",
    oldDvn: "0x0a3D1dEd83B443399073537eCd6d4040dD707731",
    executor: "0x173272739Bd7Aa6e4e214714048a9fE699453059",
    eids: [[30324, 15, 20]],
  },
  base: {
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    oldDvn: "0xf7e5bAaE563B90295ac13aD199aC3c084962b09D",
    executor: "0x2CCA08ae69E0C44b18a57Ab2A87644234dAebaE4",
    eids: [[30324, 10, 20]],
  },
  bnb: {
    chainId: 56,
    rpc: "https://bsc-dataseed1.bnbchain.org",
    legacyGasPrice: 100_000_000n,
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    oldDvn: "0xf7e5bAaE563B90295ac13aD199aC3c084962b09D",
    executor: "0x3ebD570ed38B1b3b4BC886999fcF507e9D584859",
    eids: [[30324, 20, 20]],
  },
  apechain: {
    chainId: 33139,
    rpc: "https://rpc.apechain.com/http",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    oldDvn: "0x2e57bb5c4c78F9BeDcdfaE9a8eeABE0F6f6E3FB4",
    executor: "0xcCE466a522984415bC91338c232d98869193D46e",
    eids: [[30324, 20, 20]],
  },
  robinhood: {
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    oapp: "0xD59860C069Db06A6b9f180BD0dF33352B0D9e42f",
    oldDvn: "0xf7e5bAaE563B90295ac13aD199aC3c084962b09D",
    executor: "0x4208D6E27538189bB48E603D6123A94b8Abe0A0b",
    eids: [[30324, 5, 20]],
  },
};

let step = "init";
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const redact = (err) => String(err?.shortMessage || err?.message || err).replace(/0x[a-fA-F0-9]{64}/g, "0x…");

function decodeUln(configBytes) {
  const decoded = AbiCoder.defaultAbiCoder().decode(
    ["tuple(uint64,uint8,uint8,uint8,address[],address[])"],
    configBytes,
  )[0];
  return {
    confirmations: Number(decoded[0]),
    required: decoded[4],
  };
}

function decodeExecutor(configBytes) {
  const [maxSize, executor] = AbiCoder.defaultAbiCoder().decode(["uint32", "address"], configBytes);
  return { maxSize: Number(maxSize), executor };
}

async function sendRaw(wallet, provider, tx) {
  const populated = { ...tx };
  delete populated.from;
  const signed = await wallet.signTransaction(populated);
  const hash = await provider.send("eth_sendRawTransaction", [signed]);
  for (let i = 0; i < 120; i++) {
    const rec = await provider.send("eth_getTransactionReceipt", [hash]);
    if (rec && rec.blockNumber) return { hash, status: Number(rec.status), contractAddress: rec.contractAddress };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no receipt for ${hash}`);
}

function ownerWallet() {
  let raw = process.env.BRIDGE_OWNER_PK || "";
  if (!raw) throw new Error("BRIDGE_OWNER_PK is not set");
  if (/^[0-9a-fA-F]{64}$/.test(raw)) raw = `0x${raw}`;
  const wallet = new Wallet(raw);
  if (!eq(wallet.address, OWNER)) throw new Error("BRIDGE_OWNER_PK does not derive the expected owner");
  return wallet;
}

async function readPath(provider, chain, eid) {
  const ep = new Contract(await new Contract(chain.oapp, OAPP_ABI, provider).endpoint(), EP_ABI, provider);
  const sendLib = await ep.getSendLibrary(chain.oapp, eid);
  const recv = await ep.getReceiveLibrary(chain.oapp, eid);
  const receiveLib = recv[0] ?? recv.lib;
  const execRaw = await ep.getConfig(chain.oapp, sendLib, eid, 1);
  const sendUln = decodeUln(await ep.getConfig(chain.oapp, sendLib, eid, 2));
  const recvUln = decodeUln(await ep.getConfig(chain.oapp, receiveLib, eid, 2));
  const exec = decodeExecutor(execRaw);
  return { sendLib, receiveLib, ...exec, sendUln, recvUln };
}

async function main() {
  const key = process.argv[2];
  const chain = CHAINS[key];
  if (!chain) throw new Error("unknown chain");
  const signer = process.env.BRIDGE_RELAY_SIGNER;
  if (!signer || !/^0x[a-fA-F0-9]{40}$/.test(signer)) throw new Error("BRIDGE_RELAY_SIGNER address is not set");
  const req = new FetchRequest(chain.rpc);
  req.timeout = 30_000;
  const provider = new JsonRpcProvider(req, chain.chainId, { staticNetwork: true });
  const wallet = ownerWallet().connect(provider);
  const balance = await provider.getBalance(wallet.address);
  step = "read";
  const paths = [];
  for (const [eid, sendConf, recvConf] of chain.eids) {
    const got = await readPath(provider, chain, eid);
    if (!eq(got.executor, chain.executor)) throw new Error(`executor mismatch on ${eid}`);
    if (got.maxSize !== 10000) throw new Error(`max size ${got.maxSize} on ${eid}`);
    if (got.sendUln.confirmations !== sendConf || got.recvUln.confirmations !== recvConf) {
      throw new Error(`confirmations on ${eid}: send ${got.sendUln.confirmations} recv ${got.recvUln.confirmations}`);
    }
    const allowed = [chain.oldDvn, process.env.EXECUTOR_DVN || ""].filter(Boolean);
    const sendDvn = got.sendUln.required[0];
    const recvDvn = got.recvUln.required[0];
    if (got.sendUln.required.length !== 1 || !allowed.some((a) => eq(a, sendDvn))) {
      throw new Error(`send dvn mismatch on ${eid}: ${sendDvn}`);
    }
    if (got.recvUln.required.length !== 1 || !allowed.some((a) => eq(a, recvDvn))) {
      throw new Error(`receive dvn mismatch on ${eid}: ${recvDvn}`);
    }
    paths.push({ eid, sendConf, recvConf, ...got });
  }
  step = "receiveUln";
  const receiveUln = await new Contract(chain.oldDvn, DVN_ABI, provider).receiveUln();
  const endpoint = await new Contract(chain.oapp, OAPP_ABI, provider).endpoint();
  step = "deploy";
  const bytecode = typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode.object;
  const factory = new ContractFactory(artifact.abi, bytecode, wallet);
  const nonce = await wallet.getNonce("pending");
  const existing = process.env.EXECUTOR_DVN || "";
  let dvnAddr = existing;
  let sentHash = "";
  const fee = await provider.getFeeData();
  const block = await provider.getBlock("latest");
  const base = block.baseFeePerGas ?? fee.gasPrice ?? 1_000_000n;
  const configGas = 1_500_000n * BigInt(paths.length * 2);
  let gasLimit = 1_600_000n;
  if (!existing) {
    const deployTx = await factory.getDeployTransaction(endpoint, receiveUln, chain.executor, wallet.address, signer);
    try {
      const est = await provider.estimateGas({ from: wallet.address, data: deployTx.data });
      gasLimit = (est * 12n) / 10n + 50_000n;
    } catch {
      gasLimit = 2_000_000n;
    }
  }
  const budget = (existing ? 0n : gasLimit) + configGas;
  const floor = (base * 12n) / 10n + (fee.maxPriorityFeePerGas ?? 0n);
  const cap = budget === 0n ? floor : (balance * 9n) / 10n / budget;
  if (cap < floor) {
    const need = budget * floor;
    process.stdout.write(`${JSON.stringify({ chain: key, skipped: true, balance: balance.toString(), need: need.toString(), shortfall: (need - balance).toString(), baseFee: base.toString() })}\n`);
    return;
  }
  let maxFee = fee.maxFeePerGas ?? floor;
  if (maxFee > cap) maxFee = cap;
  if (maxFee < floor) maxFee = floor;
  let priority = fee.maxPriorityFeePerGas ?? 1_000_000n;
  if (priority === 0n) priority = 1n;
  if (priority > maxFee) priority = maxFee;
  const eip1559 = !chain.legacyGasPrice && !!fee.maxFeePerGas;
  if (chain.legacyGasPrice) maxFee = chain.legacyGasPrice;
  const feeFields = eip1559 ? { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority } : { gasPrice: maxFee, type: 0 };
  if (!existing) {
    const deployTx = await factory.getDeployTransaction(endpoint, receiveUln, chain.executor, wallet.address, signer);
    const predicted = getCreateAddress({ from: wallet.address, nonce });
    const sent = await sendRaw(wallet, provider, { data: deployTx.data, nonce, gasLimit, chainId: chain.chainId, ...feeFields });
    const rec = sent;
    if (!rec || rec.status === 0) throw new Error(`deploy reverted ${sent.hash}`);
    dvnAddr = rec.contractAddress || predicted;
    sentHash = sent.hash;
  }
  const dvn = new Contract(dvnAddr, DVN_ABI, provider);
  const signerOnChain = await dvn.signer();
  if (!eq(signerOnChain, signer)) throw new Error("signer was not set on the new verifier");
  step = "config";
  const oapp = new Contract(chain.oapp, OAPP_ABI, wallet);
  const hashes = existing ? [] : [{ kind: "deploy", hash: sentHash, dvn: dvnAddr }];
  let nextNonce = existing ? nonce : nonce + 1;
  for (const path of paths) {
    const skipSend = path.sendUln.required.length === 1 && eq(path.sendUln.required[0], dvnAddr);
    const skipRecv = path.recvUln.required.length === 1 && eq(path.recvUln.required[0], dvnAddr);
    if (skipSend && skipRecv) { hashes.push({ kind: "alreadyWired", eid: path.eid }); continue; }
    const send = await oapp.setSendConfig.populateTransaction(
      path.sendLib,
      path.eid,
      path.sendConf,
      dvnAddr,
      10000,
      chain.executor,
    );
    send.nonce = nextNonce;
    send.chainId = chain.chainId;
    send.gasLimit = 1_500_000n;
    if (eip1559) {
      send.maxFeePerGas = maxFee;
      send.maxPriorityFeePerGas = priority;
    } else {
      send.gasPrice = maxFee;
      send.type = 0;
    }
    const sendTx = await sendRaw(wallet, provider, send);
    const sendRec = sendTx;
    const sendNow = await readPath(provider, chain, path.eid);
    if (sendNow.sendUln.required.length !== 1 || !eq(sendNow.sendUln.required[0], dvnAddr)) {
      throw new Error(`setSendConfig did not stick ${sendTx.hash} status ${sendRec && sendRec.status}`);
    }
    hashes.push({ kind: "setSendConfig", eid: path.eid, hash: sendTx.hash });
    nextNonce += 1;
    const recv = await oapp.setReceiveConfig.populateTransaction(path.receiveLib, path.eid, path.recvConf, dvnAddr);
    recv.nonce = nextNonce;
    recv.chainId = chain.chainId;
    recv.gasLimit = 1_500_000n;
    if (eip1559) {
      recv.maxFeePerGas = maxFee;
      recv.maxPriorityFeePerGas = priority;
    } else {
      recv.gasPrice = maxFee;
      recv.type = 0;
    }
    const recvTx = await sendRaw(wallet, provider, recv);
    const recvRec = recvTx;
    const recvNow = await readPath(provider, chain, path.eid);
    if (recvNow.recvUln.required.length !== 1 || !eq(recvNow.recvUln.required[0], dvnAddr)) {
      throw new Error(`setReceiveConfig did not stick ${recvTx.hash} status ${recvRec && recvRec.status}`);
    }
    hashes.push({ kind: "setReceiveConfig", eid: path.eid, hash: recvTx.hash });
    nextNonce += 1;
  }
  const balanceAfter = await provider.getBalance(wallet.address);
  process.stdout.write(
    `${JSON.stringify({ chain: key, dvn: dvnAddr, signer: signerOnChain, receiveUln, endpoint, txs: hashes, balanceBefore: balance.toString(), balanceAfter: balanceAfter.toString() })}\n`,
  );
}

main().catch((err) => {
  const info = {
    step,
    message: redact(err),
    code: err?.code || "",
    reason: err?.reason || err?.shortMessage || "",
    data: typeof err?.data === "string" ? err.data.slice(0, 180) : "",
    inner: redact(err?.error?.message || err?.info?.error?.message || ""),
    hash: err?.receipt?.hash || err?.transaction?.hash || "",
  };
  process.stderr.write(`${JSON.stringify(info)}\n`);
  process.exit(1);
});
