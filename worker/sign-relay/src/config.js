// Generated from docs/dvn.json by npm run sync-config. Do not edit.
export default {
  "signer": "0x592bcc953F683C4B0A42b0950af1DA18AAfF55e3",
  "signRelayUrl": "https://bridge-sign-relay.mcontwitter.workers.dev/api/sign-relay",
  "byEid": {
    "30101": "0x58f2c9ee48b086539181512a79750a49a9ba433c",
    "30102": "0x8395b0014d95be967189547faa6065c30dea0e85",
    "30184": "0x56de702beda3c03e26d13d5475bca5b365f89767",
    "30312": "0x8395b0014d95be967189547faa6065c30dea0e85",
    "30324": "0xcdc640614d511ee4811b522650b1c5c90b59ddbc",
    "30416": "0x0a3d1ded83b443399073537ecd6d4040dd707731"
  },
  "chains": {
    "1": {
      "name": "ethereum",
      "eid": 30101,
      "rpc": [
        "https://ethereum.publicnode.com",
        "https://ethereum.reth.rs/rpc",
        "https://eth.drpc.org",
        "https://1rpc.io/eth"
      ],
      "endpoint": "0x1a44076050125825900e736c501f859c50fE728c"
    },
    "56": {
      "name": "bnb",
      "eid": 30102,
      "rpc": [
        "https://bsc-dataseed1.bnbchain.org",
        "https://bsc-rpc.publicnode.com",
        "https://bsc.drpc.org",
        "https://1rpc.io/bnb"
      ],
      "endpoint": "0x1a44076050125825900e736c501f859c50fE728c"
    },
    "2741": {
      "name": "abstract",
      "eid": 30324,
      "rpc": [
        "https://api.mainnet.abs.xyz",
        "https://abstract.drpc.org"
      ],
      "endpoint": "0x5c6cfF4b7C49805F8295Ff73C204ac83f3bC4AE7"
    },
    "4663": {
      "name": "robinhood",
      "eid": 30416,
      "rpc": [
        "https://rpc.mainnet.chain.robinhood.com"
      ],
      "endpoint": "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B"
    },
    "8453": {
      "name": "base",
      "eid": 30184,
      "rpc": [
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
        "https://base.drpc.org",
        "https://1rpc.io/base",
        "https://base.llamarpc.com"
      ],
      "endpoint": "0x1a44076050125825900e736c501f859c50fE728c"
    },
    "33139": {
      "name": "apechain",
      "eid": 30312,
      "rpc": [
        "https://rpc.apechain.com/http",
        "https://apechain.drpc.org"
      ],
      "endpoint": "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B"
    }
  },
  "maxNativeFee": {
    "1": "10000000000000000",
    "56": "30000000000000000",
    "2741": "10000000000000000",
    "4663": "10000000000000000",
    "8453": "10000000000000000",
    "33139": "150000000000000000000"
  },
  "lzReceiveGas": 1,
  "lockPaused": false,
  "returnPaused": false
};
