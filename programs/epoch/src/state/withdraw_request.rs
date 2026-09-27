use anchor_lang::prelude::*;

use super::Tranche;

/// A queued withdrawal (seeds: `["withdraw", pool, seq]`). Requests are paid
/// strictly in `seq` order, whole-or-nothing, at the share price on the day
/// they are processed. That keeps a run fair: nobody jumps the queue and the
/// queue never pays out cash that an earlier request is waiting for.
#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub tranche: Tranche,
    pub shares: u64,
    pub seq: u64,
    pub requested_epoch: u64,
    pub cancelled: bool,
    pub bump: u8,
    pub _reserved: [u8; 16],
}
