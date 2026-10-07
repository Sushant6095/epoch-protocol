//! Program-derived addresses, all derived from [`TEST_PROGRAM_ID`] with the
//! program's own seed constants.

use anchor_lang::prelude::Pubkey;
use epoch::constants::{
    ADVANCE_SEED, BUYBACK_SEED, BUYBACK_TOKENS_SEED, BUYBACK_WSOL_SEED, ESCROW_SEED,
    FEE_INDEX_SEED, HISTORY_SEED, LENDER_SEED, PARTNER_TREASURY_SEED, POOL_SEED, POSITION_SEED,
    QUOTE_SEED, REVENUE_TOKEN_SEED, SWAP_SEED, TREASURY_WSOL_SEED, VAULT_SEED, VOTE_AUTH_SEED,
    WITHDRAW_SEED,
};
use epoch::state::Tranche;

/// The id the LiteSVM build of the program is deployed at. `build-sbf.sh`
/// writes the same id into `declare_id!` of its copy of the crate; the bytes
/// spell `epoch-litesvm-test-program-id-v1`.
pub const TEST_PROGRAM_ID: Pubkey =
    anchor_lang::prelude::pubkey!("7pyci4ooVzsJH6Q5whahGNFwyjqhRhhm365jQkeWQ6tg");

pub fn find(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &TEST_PROGRAM_ID)
}

pub fn pool() -> Pubkey {
    find(&[POOL_SEED]).0
}

pub fn vault() -> Pubkey {
    find(&[VAULT_SEED, pool().as_ref()]).0
}

pub fn lender(owner: &Pubkey, tranche: Tranche) -> Pubkey {
    find(&[
        LENDER_SEED,
        pool().as_ref(),
        owner.as_ref(),
        &[tranche.as_u8()],
    ])
    .0
}

pub fn withdraw_request(seq: u64) -> Pubkey {
    find(&[WITHDRAW_SEED, pool().as_ref(), &seq.to_le_bytes()]).0
}

pub fn position(vote: &Pubkey) -> Pubkey {
    find(&[POSITION_SEED, vote.as_ref()]).0
}

pub fn vote_auth(vote: &Pubkey) -> Pubkey {
    find(&[VOTE_AUTH_SEED, vote.as_ref()]).0
}

/// The validator's `ValidatorHistory` (`["history", vote]`); `update_score` takes it, existing or not.
pub fn validator_history(vote: &Pubkey) -> Pubkey {
    find(&[HISTORY_SEED, vote.as_ref()]).0
}

pub fn escrow(vote: &Pubkey) -> Pubkey {
    find(&[ESCROW_SEED, vote.as_ref()]).0
}

pub fn advance(vote: &Pubkey, seq: u64) -> Pubkey {
    find(&[ADVANCE_SEED, vote.as_ref(), &seq.to_le_bytes()]).0
}

pub fn fee_index() -> Pubkey {
    find(&[FEE_INDEX_SEED, pool().as_ref()]).0
}

pub fn quote(maker: &Pubkey, epoch: u64) -> Pubkey {
    find(&[QUOTE_SEED, maker.as_ref(), &epoch.to_le_bytes()]).0
}

pub fn swap(quote: &Pubkey, taker: &Pubkey) -> Pubkey {
    find(&[SWAP_SEED, quote.as_ref(), taker.as_ref()]).0
}

pub fn revenue_token(vote: &Pubkey) -> Pubkey {
    find(&[REVENUE_TOKEN_SEED, vote.as_ref()]).0
}

pub fn buyback(vote: &Pubkey) -> Pubkey {
    find(&[BUYBACK_SEED, vote.as_ref()]).0
}

pub fn buyback_wsol(vote: &Pubkey) -> Pubkey {
    find(&[BUYBACK_WSOL_SEED, vote.as_ref()]).0
}

pub fn buyback_tokens(vote: &Pubkey) -> Pubkey {
    find(&[BUYBACK_TOKENS_SEED, vote.as_ref()]).0
}

pub fn partner_treasury() -> Pubkey {
    find(&[PARTNER_TREASURY_SEED, pool().as_ref()]).0
}

pub fn treasury_wsol() -> Pubkey {
    find(&[TREASURY_WSOL_SEED, pool().as_ref()]).0
}
