/**
 * The Metaplex token-metadata account DBC creates for every SPL launch, decoded by hand (browser-safe), to verify the
 * launch's immutability: Epoch's preset (`TokenAuthorityOption.Immutable`) creates it with `is_mutable = false` and then
 * hands the update authority to the System Program, so nobody can ever change the name, symbol or URI.
 */
import { deriveMintMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type Connection, PublicKey, SystemProgram } from '@solana/web3.js';

export interface TokenMetadata {
  /** The metadata PDA. */
  address: string;
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  isMutable: boolean;
  /** Nobody can update it: immutable, or the update authority is the System Program. */
  locked: boolean;
}

/** Decodes a Metaplex `Metadata` account (key 4, `MetadataV1`). Throws on another account. */
export function decodeTokenMetadata(data: Uint8Array, address = ''): TokenMetadata {
  if (data[0] !== 4) throw new RangeError(`not a Metaplex metadata account (key ${data[0]})`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 1;
  const key = () => {
    const value = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return value;
  };
  const text = () => {
    const length = view.getUint32(offset, true);
    offset += 4;
    const value = new TextDecoder().decode(data.subarray(offset, offset + length)).replace(/\0+$/, '');
    offset += length;
    return value;
  };
  const updateAuthority = key();
  const mint = key();
  const name = text();
  const symbol = text();
  const uri = text();
  const sellerFeeBasisPoints = view.getUint16(offset, true);
  offset += 2;
  if (data[offset++] === 1) offset += 4 + view.getUint32(offset, true) * 34; // creators: Vec<{ key, verified, share }>
  offset += 1; // primary_sale_happened
  const isMutable = data[offset] === 1;
  return {
    address,
    updateAuthority,
    mint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    isMutable,
    locked: !isMutable || updateAuthority === SystemProgram.programId.toBase58(),
  };
}

/** Reads a mint's Metaplex metadata; null when there is none. */
export async function readTokenMetadata(params: {
  connection: Connection;
  mint: PublicKey | string;
}): Promise<TokenMetadata | null> {
  const address = deriveMintMetadata(new PublicKey(params.mint));
  const info = await params.connection.getAccountInfo(address, 'confirmed');
  return info ? decodeTokenMetadata(info.data, address.toBase58()) : null;
}
