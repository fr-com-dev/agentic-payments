// `npm run -s wallet-mnemonic` (specs/013 quickstart §6). Prints exactly one new 24-word BIP-39 mnemonic and a
// newline, nothing else. THE OUTPUT IS A SECRET: it is the key to every user's crypto account. Pipe it straight into
// the vault and keep one backup where the payer key's backup is kept; never write it to a file in the repository, a
// shell history, a log or a chat.
//
//   npm run -s wallet-mnemonic | az keyvault secret set --vault-name <kv-l2> -n user-wallet-mnemonic --file /dev/stdin -o none
//
// It reads no env file and derives no account (INV-2: only the L2 signer turns the phrase into accounts).
import { english, generateMnemonic } from "viem/accounts";

process.stdout.write(generateMnemonic(english, 256) + "\n");
