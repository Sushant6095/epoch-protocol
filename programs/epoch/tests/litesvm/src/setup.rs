//! Standard protocol setup (the parameters the localnet seed uses) and
//! one-call wrappers for the common steps, so a scenario reads like the
//! protocol flow it tests.

use anchor_lang::prelude::Pubkey;
use epoch::state::{LenderShares, Pool, PoolParams, Tranche};

use crate::context::{sol, TestContext, TxResult};
use crate::{ix, pda};

/// The localnet seed's parameters, except `junior_lock_epochs` (2 there too).
pub fn default_params() -> PoolParams {
    PoolParams {
        senior_rate_bps_per_epoch: 3,
        protocol_fee_bps: 1_000,
        advance_bps_unhedged: 2_500,
        advance_bps_hedged: 4_000,
        bond_multiplier: 4,
        fee_bps: 200,
        remit_bps: 5_000,
        min_score: 6_000,
        score_ttl_epochs: 3,
        min_advance_lamports: sol(1.0),
        max_advance_lamports: sol(500.0),
        max_pool_assets: sol(5_000.0),
        max_utilization_bps: 6_000,
        min_junior_bps: 2_000,
        junior_lock_epochs: 2,
        max_advance_epochs: 20,
        vote_reserve_lamports: sol(1.6),
        min_commission_bps: 0,
    }
}

impl TestContext {
    /// A cluster with the pool initialised by `admin` with [`default_params`]
    /// (`treasury` and `scorer` wallets as roles).
    pub fn with_pool() -> Self {
        Self::with_pool_params(default_params())
    }

    pub fn with_pool_params(params: PoolParams) -> Self {
        let mut ctx = Self::new();
        let admin = ctx.wallet("admin");
        let treasury = ctx.wallet_with("treasury", 1.0);
        let scorer = ctx.wallet("scorer");
        ctx.send_as(
            &[ix::initialize_pool(admin, treasury, scorer, params)],
            &["admin"],
        )
        .expect("initialize_pool");
        ctx
    }

    pub fn pool(&self) -> Pool {
        self.get(&pda::pool())
    }

    pub fn lender(&self, owner: &Pubkey, tranche: Tranche) -> LenderShares {
        self.get(&pda::lender(owner, tranche))
    }

    /// `deposit` from the named wallet (created with 1,000 SOL on first use).
    pub fn deposit(&mut self, who: &str, tranche: Tranche, lamports: u64) -> TxResult {
        let owner = self.wallet_with(who, 1_000.0);
        self.send_as(&[ix::deposit(owner, tranche, lamports)], &[who])
    }

    /// `request_withdraw` at the queue tail; returns the request's sequence number.
    pub fn request_withdraw(
        &mut self,
        who: &str,
        tranche: Tranche,
        shares: u64,
    ) -> Result<u64, crate::TxErr> {
        let owner = self.key(who);
        let seq = self.pool().withdraw_tail;
        self.send_as(&[ix::request_withdraw(owner, tranche, seq, shares)], &[who])?;
        Ok(seq)
    }

    /// `process_withdrawal` of request `seq`, cranked by the `crank` wallet.
    pub fn process_withdrawal(&mut self, owner: &Pubkey, tranche: Tranche, seq: u64) -> TxResult {
        let cranker = self.wallet("crank");
        self.send_as(
            &[ix::process_withdrawal(cranker, *owner, tranche, seq)],
            &["crank"],
        )
    }

    /// `accrue`, cranked by the `crank` wallet.
    pub fn accrue(&mut self) -> TxResult {
        let cranker = self.wallet("crank");
        let treasury = self.pool().treasury;
        self.send_as(&[ix::accrue(cranker, treasury)], &["crank"])
    }

    /// Assert the pool's own ledger identity and that the vault holds at least
    /// what the ledger says it should.
    #[track_caller]
    pub fn assert_ledger(&self) {
        let pool = self.pool();
        pool.assert_ledger().expect("pool ledger identity");
        let rent = self.rent_exempt(0);
        let required = pool
            .required_vault_lamports(rent)
            .expect("required vault lamports");
        let vault = self.lamports(&pda::vault());
        assert!(
            vault >= required,
            "vault {vault} below the ledger's {required}"
        );
    }
}
