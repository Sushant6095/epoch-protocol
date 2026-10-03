#!/usr/bin/env node
import '@epoch/common/first-module';

import { createInterface } from 'readline/promises';

import { loadConfig, OperatorConfigSchema } from '@epoch/config-sdk';
import { ConnectionManager, loadKeypair, TransactionSender } from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

import { parseCommand, USAGE, UsageError } from './Cli';
import { runCommand } from './Operator';
import { OperatorChain } from './OperatorChain';

const out = (text: string): void => void process.stdout.write(`${text}\n`);

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  let command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (command.name === 'help') {
    out(USAGE);
    return 0;
  }

  const config = loadConfig(OperatorConfigSchema);
  const operator = loadKeypair(config.OPERATOR_KEYPAIR_PATH);
  const connections = new ConnectionManager(config.EPOCH_RPC_URL, config.EPOCH_RPC_FALLBACK_URL);
  const chain = new OperatorChain(
    new PublicKey(config.EPOCH_PROGRAM_ID),
    connections,
    new TransactionSender(connections, operator),
    config.OPERATOR_CU_PRICE_MICROLAMPORTS,
  );
  const cluster = config.EPOCH_CLUSTER === 'mainnet' ? '' : `?cluster=${config.EPOCH_CLUSTER}`;
  return runCommand(command, chain, {
    out,
    confirm,
    loadKeypair,
    explorer: (signature) =>
      config.EPOCH_CLUSTER === 'localnet'
        ? `(localnet) ${signature}`
        : `https://explorer.solana.com/tx/${signature}${cluster}`,
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
