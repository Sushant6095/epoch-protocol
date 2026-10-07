//! Byte-exact test vectors for `@epoch/epoch-sdk`, produced by the real `epoch` program crate.
//!
//! Writes `../src/__fixtures__/rust-vectors.json` (path overridable with the first CLI argument):
//! account discriminators, sizes and serialized examples; instruction data and account metas;
//! event bytes; PDAs; the error table; and math cases. Every value comes from the program's own
//! types and functions (`AccountSerialize`, `InstructionData`, `ToAccountMetas`, `Event::data`,
//! `Pubkey::find_program_address`, `epoch::math`), so the SDK tests compare against the chain's
//! encoding rather than a re-derivation of it.
//!
//! Struct fields are listed through exhaustive destructuring (no `..`), so a field added to the
//! program fails this build until the vector generator lists it too.

use std::{fs, path::PathBuf};

use anchor_lang::{
    prelude::*, solana_program::instruction::AccountMeta, Discriminator, Event, InstructionData,
    Space, ToAccountMetas,
};
use epoch::{
    constants::*,
    errors::EpochError,
    events::*,
    instructions::{taker_pnl, ScoreUpdate, ScoringParams},
    math::{self, u256::U256, CreditInputs, CurvePoint, ScoreInputs, SliceTiming},
    state::*,
};

// ─── JSON ──────────────────────────────────────────────────────────────────

enum J {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl J {
    fn is_scalar(&self) -> bool {
        !matches!(self, J::Arr(_) | J::Obj(_))
    }

    fn inline(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Int(n) => out.push_str(&n.to_string()),
            J::Str(s) => {
                out.push('"');
                for c in s.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            J::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    item.inline(out);
                }
                out.push(']');
            }
            J::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    J::Str(k.clone()).inline(out);
                    out.push_str(": ");
                    v.inline(out);
                }
                out.push('}');
            }
        }
    }

    /// Pretty-print, keeping any container whose one-line form is short on one line.
    fn pretty(&self, out: &mut String, depth: usize) {
        let mut line = String::new();
        self.inline(&mut line);
        if self.is_scalar() || line.len() + depth * 2 <= 118 {
            out.push_str(&line);
            return;
        }
        let pad = "  ".repeat(depth + 1);
        let end = "  ".repeat(depth);
        match self {
            J::Arr(items) => {
                out.push_str("[\n");
                for (i, item) in items.iter().enumerate() {
                    out.push_str(&pad);
                    item.pretty(out, depth + 1);
                    out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
                }
                out.push_str(&end);
                out.push(']');
            }
            J::Obj(fields) => {
                out.push_str("{\n");
                for (i, (k, v)) in fields.iter().enumerate() {
                    out.push_str(&pad);
                    J::Str(k.clone()).inline(out);
                    out.push_str(": ");
                    v.pretty(out, depth + 1);
                    out.push_str(if i + 1 < fields.len() { ",\n" } else { "\n" });
                }
                out.push_str(&end);
                out.push('}');
            }
            _ => unreachable!(),
        }
    }
}

fn obj(fields: Vec<(&str, J)>) -> J {
    J::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

fn s(v: impl ToString) -> J {
    J::Str(v.to_string())
}

fn hex(bytes: &[u8]) -> J {
    J::Str(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// `{ field: value }` for every field of a struct. The destructuring has no `..`, so the build
/// fails if the struct gains a field this list does not name (in `fields` or `skip`).
macro_rules! fields {
    ($value:expr, $($ty:ident)::+ { $($f:ident),* $(,)? } skip { $($s:ident),* $(,)? }) => {{
        let $($ty)::+ { $($f,)* $($s: _,)* } = $value;
        obj(vec![$((stringify!($f), ToJ::j($f))),*])
    }};
}

/// Rust value → JSON. Integers up to 32 bits are numbers; 64-bit integers are decimal strings
/// (JavaScript numbers cannot hold them); pubkeys are base58; byte arrays are hex; enums are the
/// Rust variant name.
trait ToJ {
    fn j(&self) -> J;
}

impl ToJ for u8 {
    fn j(&self) -> J {
        J::Int(i64::from(*self))
    }
}
impl ToJ for u16 {
    fn j(&self) -> J {
        J::Int(i64::from(*self))
    }
}
impl ToJ for u32 {
    fn j(&self) -> J {
        J::Int(i64::from(*self))
    }
}
impl ToJ for u64 {
    fn j(&self) -> J {
        s(self)
    }
}
impl ToJ for i64 {
    fn j(&self) -> J {
        s(self)
    }
}
impl ToJ for bool {
    fn j(&self) -> J {
        J::Bool(*self)
    }
}
impl ToJ for Pubkey {
    fn j(&self) -> J {
        s(self)
    }
}
impl ToJ for [u8; 32] {
    fn j(&self) -> J {
        hex(self)
    }
}
impl ToJ for ScoringParams {
    fn j(&self) -> J {
        obj(vec![
            (
                "market_maker",
                if self.market_maker == Pubkey::default() {
                    J::Null
                } else {
                    self.market_maker.j()
                },
            ),
            ("credits_window_epochs", self.credits_window_epochs.j()),
            ("count_block_commission", self.count_block_commission.j()),
            ("credits_reference_bps", self.credits_reference_bps.j()),
            ("max_copy_age_slots", self.max_copy_age_slots.j()),
        ])
    }
}
impl<T: ToJ> ToJ for Option<T> {
    fn j(&self) -> J {
        self.as_ref().map_or(J::Null, ToJ::j)
    }
}
impl ToJ for [u64; REVENUE_WINDOW] {
    fn j(&self) -> J {
        J::Arr(self.iter().map(ToJ::j).collect())
    }
}
impl ToJ for IndexPoint {
    fn j(&self) -> J {
        let IndexPoint { epoch, value } = self;
        obj(vec![("epoch", epoch.j()), ("value", value.j())])
    }
}
impl ToJ for [IndexPoint; INDEX_HISTORY] {
    fn j(&self) -> J {
        J::Arr(self.iter().map(ToJ::j).collect())
    }
}
impl ToJ for Tranche {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for Side {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for PositionStatus {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for AdvanceState {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for RevenueTokenStatus {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for BuybackVenue {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for TreasuryClaimKind {
    fn j(&self) -> J {
        s(format!("{self:?}"))
    }
}
impl ToJ for u128 {
    fn j(&self) -> J {
        s(self)
    }
}
impl ToJ for U256 {
    /// Decimal, like the other wide integers.
    fn j(&self) -> J {
        const TEN19: u128 = 10_000_000_000_000_000_000;
        let mut v = *self;
        let mut chunks = Vec::new();
        while !v.is_zero() {
            let (q, r) = v.div_rem(U256::from_u128(TEN19)).expect("nonzero divisor");
            chunks.push(r.lo);
            v = q;
        }
        let mut text = chunks
            .pop()
            .map_or_else(|| "0".to_string(), |c| c.to_string());
        while let Some(c) = chunks.pop() {
            text.push_str(&format!("{c:019}"));
        }
        s(text)
    }
}
impl ToJ for BuybackParams {
    fn j(&self) -> J {
        fields!(self, BuybackParams {
            slices_per_epoch, window_slots, max_slippage_bps, max_impact_bps, flags,
        } skip {})
    }
}
impl ToJ for PoolParams {
    fn j(&self) -> J {
        fields!(self, PoolParams {
            senior_rate_bps_per_epoch, protocol_fee_bps, advance_bps_unhedged, advance_bps_hedged,
            bond_multiplier, fee_bps, remit_bps, min_score, score_ttl_epochs, min_advance_lamports,
            max_advance_lamports, max_pool_assets, max_utilization_bps, min_junior_bps,
            junior_lock_epochs, max_advance_epochs, vote_reserve_lamports, min_commission_bps,
        } skip {})
    }
}
impl ToJ for ScoreUpdate {
    fn j(&self) -> J {
        fields!(self, ScoreUpdate {
            credits_ratio_bps, commission_bps, epochs_active, delinquent, superminority, hedged,
        } skip {})
    }
}

// ─── Deterministic values ──────────────────────────────────────────────────

/// A 64-bit LCG: distinctive, reproducible field values (every bit pattern, incl. > 2^53 and > 2^63).
struct Gen(u64);

impl Gen {
    fn u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 ^ (self.0 >> 29)
    }
    /// Values of every magnitude, from tiny to full width.
    fn sized(&mut self) -> u64 {
        let v = self.u64();
        let shift = self.u64() % 64;
        v >> shift
    }
    fn u32(&mut self) -> u32 {
        (self.u64() >> 32) as u32
    }
    fn u16(&mut self) -> u16 {
        (self.u64() >> 48) as u16
    }
    fn u8(&mut self) -> u8 {
        (self.u64() >> 56) as u8
    }
    fn i64(&mut self) -> i64 {
        self.u64() as i64
    }
    fn bytes32(&mut self) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.u64().to_le_bytes());
        }
        out
    }
    fn key(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.bytes32())
    }
}

fn k(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}

fn addr(seeds: &[&[u8]], program_id: &Pubkey) -> Pubkey {
    pda(seeds, program_id).0
}

// ─── Accounts ──────────────────────────────────────────────────────────────

/// Serialize like the chain does: `try_serialize` (discriminator + Borsh) written over the
/// allocated `8 + INIT_SPACE` buffer (zeroed for a new account, or the previous contents for an
/// account that is being rewritten), then read back with the program's own deserializer.
fn account_bytes<T>(value: &T, previous: Option<&[u8]>) -> (Vec<u8>, usize)
where
    T: AccountSerialize + AccountDeserialize + Space,
{
    let size = 8 + T::INIT_SPACE;
    let mut ser = Vec::new();
    value.try_serialize(&mut ser).expect("serialize");
    assert!(
        ser.len() <= size,
        "serialized {} > allocated {}",
        ser.len(),
        size
    );
    let mut data = previous.map_or_else(|| vec![0u8; size], <[u8]>::to_vec);
    assert_eq!(data.len(), size);
    data[..ser.len()].copy_from_slice(&ser);

    let back = T::try_deserialize(&mut &data[..]).expect("program deserializer rejects vector");
    let mut again = Vec::new();
    back.try_serialize(&mut again).expect("re-serialize");
    assert_eq!(
        ser, again,
        "round trip through the program's deserializer changed the account"
    );
    (data, ser.len())
}

fn example(label: &str, data: &[u8], serialized_len: usize, fields: J, extra: Vec<(&str, J)>) -> J {
    let mut v = vec![
        ("label", s(label)),
        ("serializedLen", J::Int(serialized_len as i64)),
        ("data", hex(data)),
        ("fields", fields),
    ];
    v.extend(extra);
    obj(v)
}

fn pool_params(g: &mut Gen) -> PoolParams {
    PoolParams {
        senior_rate_bps_per_epoch: g.u16(),
        protocol_fee_bps: g.u16(),
        advance_bps_unhedged: g.u16(),
        advance_bps_hedged: g.u16(),
        bond_multiplier: g.u8(),
        fee_bps: g.u16(),
        remit_bps: g.u16(),
        min_score: g.u16(),
        score_ttl_epochs: g.u16(),
        min_advance_lamports: g.u64(),
        max_advance_lamports: g.u64(),
        max_pool_assets: g.u64(),
        max_utilization_bps: g.u16(),
        min_junior_bps: g.u16(),
        junior_lock_epochs: g.u16(),
        max_advance_epochs: g.u16(),
        vote_reserve_lamports: g.u64(),
        min_commission_bps: g.u16(),
    }
}

fn pool_json(p: &Pool) -> J {
    fields!(p, Pool {
        admin, treasury, scorer, params, bump, vault_bump, paused, cash, outstanding_principal,
        expected_fees, income_unallocated, bond_total, senior_assets, senior_shares, junior_assets,
        junior_shares, senior_pending_shares, junior_pending_shares, withdraw_head, withdraw_tail,
        last_accrued_epoch, validators, open_advances, total_advanced, total_repaid,
        total_defaulted,
    } skip { _reserved })
}

fn pool_examples(g: &mut Gen) -> Vec<J> {
    [true, false]
        .into_iter()
        .map(|flag| {
            let p = Pool {
                admin: g.key(),
                treasury: g.key(),
                scorer: g.key(),
                params: pool_params(g),
                bump: g.u8(),
                vault_bump: g.u8(),
                paused: flag,
                cash: g.u64(),
                outstanding_principal: g.u64(),
                expected_fees: g.u64(),
                income_unallocated: g.u64(),
                bond_total: g.u64(),
                senior_assets: g.u64(),
                senior_shares: g.u64(),
                junior_assets: g.u64(),
                junior_shares: g.u64(),
                senior_pending_shares: g.u64(),
                junior_pending_shares: g.u64(),
                withdraw_head: g.u64(),
                withdraw_tail: g.u64(),
                last_accrued_epoch: g.u64(),
                validators: g.u32(),
                open_advances: g.u32(),
                total_advanced: g.u64(),
                total_repaid: g.u64(),
                total_defaulted: g.u64(),
                _reserved: [if flag { 0xab } else { 0 }; 64],
            };
            let (data, len) = account_bytes(&p, None);
            example(
                if flag { "paused" } else { "unpaused" },
                &data,
                len,
                pool_json(&p),
                vec![],
            )
        })
        .collect()
}

fn lender_json(a: &LenderShares) -> J {
    fields!(a, LenderShares {
        pool, owner, tranche, shares, pending_shares, last_deposit_epoch, total_deposited,
        total_withdrawn, bump,
    } skip { _reserved })
}

fn lender_examples(g: &mut Gen) -> Vec<J> {
    [Tranche::Junior, Tranche::Senior]
        .into_iter()
        .map(|tranche| {
            let a = LenderShares {
                pool: g.key(),
                owner: g.key(),
                tranche,
                shares: g.u64(),
                pending_shares: g.u64(),
                last_deposit_epoch: g.u64(),
                total_deposited: g.u64(),
                total_withdrawn: g.u64(),
                bump: g.u8(),
                _reserved: [0x5a; 16],
            };
            let (data, len) = account_bytes(&a, None);
            example(&format!("{tranche:?}"), &data, len, lender_json(&a), vec![])
        })
        .collect()
}

fn withdraw_json(a: &WithdrawRequest) -> J {
    fields!(a, WithdrawRequest {
        pool, owner, tranche, shares, seq, requested_epoch, cancelled, bump,
    } skip { _reserved })
}

fn withdraw_examples(g: &mut Gen) -> Vec<J> {
    [(Tranche::Junior, true), (Tranche::Senior, false)]
        .into_iter()
        .map(|(tranche, cancelled)| {
            let a = WithdrawRequest {
                pool: g.key(),
                owner: g.key(),
                tranche,
                shares: g.u64(),
                seq: g.u64(),
                requested_epoch: g.u64(),
                cancelled,
                bump: g.u8(),
                _reserved: [0; 16],
            };
            let (data, len) = account_bytes(&a, None);
            example(
                &format!("{tranche:?}"),
                &data,
                len,
                withdraw_json(&a),
                vec![],
            )
        })
        .collect()
}

/// An all-zero pubkey field read as "none" (`null`), like the SDK's decoders.
fn optional_key(key: &Pubkey) -> J {
    if *key == Pubkey::default() {
        J::Null
    } else {
        key.j()
    }
}

/// `fields!` plus one more field at the end.
fn with_field(mut fields: J, name: &str, value: J) -> J {
    if let J::Obj(f) = &mut fields {
        f.push((name.to_string(), value));
    }
    fields
}

fn position_json(a: &ValidatorPosition) -> J {
    let fields = fields!(a, ValidatorPosition {
        pool, vote, identity, operator, payout, original_withdrawer, bump, vote_auth_bump,
        escrow_bump, status, hedged, score, last_scored_epoch, revenue, revenue_head,
        revenue_count, last_swept_epoch, total_swept, total_remitted, bond_lamports, open_advance,
        advance_seq, late_epochs, inflation_commission_bps, block_commission_bps, onboarded_epoch,
    } skip { revenue_token });
    with_field(fields, "revenue_token", optional_key(&a.revenue_token))
}

fn position(
    g: &mut Gen,
    status: PositionStatus,
    hedged: bool,
    open_advance: Option<Pubkey>,
) -> ValidatorPosition {
    ValidatorPosition {
        pool: g.key(),
        vote: g.key(),
        identity: g.key(),
        operator: g.key(),
        payout: g.key(),
        original_withdrawer: g.key(),
        bump: g.u8(),
        vote_auth_bump: g.u8(),
        escrow_bump: g.u8(),
        status,
        hedged,
        score: g.u16(),
        last_scored_epoch: g.u64(),
        revenue: [0; REVENUE_WINDOW],
        revenue_head: 0,
        revenue_count: 0,
        last_swept_epoch: g.u64(),
        total_swept: g.u64(),
        total_remitted: g.u64(),
        bond_lamports: g.u64(),
        open_advance,
        advance_seq: g.u64(),
        late_epochs: g.u8(),
        inflation_commission_bps: g.u16(),
        block_commission_bps: g.u16(),
        onboarded_epoch: g.u64(),
        // Non-zero so a stale tail left by a Some → None rewrite is visible garbage (these
        // were the `_reserved` bytes before they became `revenue_token`).
        revenue_token: Pubkey::new_from_array([0xc3; 32]),
    }
}

fn position_examples(g: &mut Gen) -> Vec<J> {
    let mut out = Vec::new();
    let extra = |p: &ValidatorPosition, pushed: &[u64]| {
        vec![
            ("pushedRevenue", J::Arr(pushed.iter().map(ToJ::j).collect())),
            ("trailingRevenue", p.trailing_revenue().j()),
        ]
    };

    // Open advance (Some); ring wrapped (13 pushes into the 10-slot window).
    let adv = g.key();
    let mut some = position(g, PositionStatus::Late, true, Some(adv));
    let mut pushed: Vec<u64> = (0..13).map(|_| g.sized()).collect();
    for v in &pushed {
        some.push_revenue(*v);
    }
    let (some_data, len) = account_bytes(&some, None);
    out.push(example(
        "open_advance_some",
        &some_data,
        len,
        position_json(&some),
        extra(&some, &pushed),
    ));

    // The realistic None: the advance was repaid, so `open_advance` went Some → None and the
    // program rewrote the account over its previous bytes. Everything after the Option shifts
    // 32 bytes left and the old tail stays behind as garbage.
    let mut repaid = ValidatorPosition::try_deserialize(&mut &some_data[..]).expect("copy");
    repaid.open_advance = None;
    repaid.status = PositionStatus::Defaulted;
    repaid.late_epochs = 0;
    for v in [u64::MAX, 0, 1] {
        repaid.push_revenue(v);
        pushed.push(v);
    }
    let (data, len) = account_bytes(&repaid, Some(&some_data));
    out.push(example(
        "open_advance_none_over_some",
        &data,
        len,
        position_json(&repaid),
        extra(&repaid, &pushed),
    ));

    // None on a fresh, zeroed account; partial ring (4 pushes); no revenue token (null).
    let mut fresh = position(g, PositionStatus::Active, false, None);
    fresh.revenue_token = Pubkey::default();
    let pushed: Vec<u64> = (0..4).map(|_| g.sized()).collect();
    for v in &pushed {
        fresh.push_revenue(*v);
    }
    let (data, len) = account_bytes(&fresh, None);
    out.push(example(
        "open_advance_none",
        &data,
        len,
        position_json(&fresh),
        extra(&fresh, &pushed),
    ));

    // Trailing revenue saturates at u64::MAX.
    let mut big = position(g, PositionStatus::Released, true, None);
    let pushed: Vec<u64> = vec![u64::MAX - 5, 3, 7];
    for v in &pushed {
        big.push_revenue(*v);
    }
    let (data, len) = account_bytes(&big, None);
    out.push(example(
        "saturating_revenue",
        &data,
        len,
        position_json(&big),
        extra(&big, &pushed),
    ));
    out
}

fn advance_json(a: &Advance) -> J {
    fields!(a, Advance {
        pool, vote, position, seq, principal, fee, total_due, repaid, principal_repaid, fee_repaid,
        remit_bps, opened_epoch, closed_epoch, state, bump,
    } skip { _reserved })
}

fn advance_examples(g: &mut Gen) -> Vec<J> {
    [
        AdvanceState::Defaulted,
        AdvanceState::Repaid,
        AdvanceState::Open,
    ]
    .into_iter()
    .map(|state| {
        let a = Advance {
            pool: g.key(),
            vote: g.key(),
            position: g.key(),
            seq: g.u64(),
            principal: g.u64(),
            fee: g.u64(),
            total_due: g.u64(),
            repaid: g.u64(),
            principal_repaid: g.u64(),
            fee_repaid: g.u64(),
            remit_bps: g.u16(),
            opened_epoch: g.u64(),
            closed_epoch: g.u64(),
            state,
            bump: g.u8(),
            _reserved: [0; 16],
        };
        let (data, len) = account_bytes(&a, None);
        example(&format!("{state:?}"), &data, len, advance_json(&a), vec![])
    })
    .collect()
}

fn fee_index_json(a: &FeeIndex) -> J {
    fields!(a, FeeIndex {
        pool, publisher, bump, epoch, value, inputs_hash, finalized_slot, has_proposal,
        proposed_epoch, proposed_value, proposed_inputs_hash, proposed_slot, dispute_window_slots,
        max_move_bps, history, history_head, history_count,
    } skip { _reserved })
}

fn fee_index_examples(g: &mut Gen) -> Vec<J> {
    let mut out = Vec::new();
    // (label, pushes, has_proposal, finalized_slot)
    for (label, pushes, has_proposal, finalized) in [
        ("wrapped_history", 21usize, true, true),
        ("partial_history", 3, false, true),
        ("unfinalized", 0, false, false),
        ("duplicate_epochs", 5, true, true),
    ] {
        let mut a = FeeIndex {
            pool: g.key(),
            publisher: g.key(),
            bump: g.u8(),
            epoch: 0,
            value: g.u64(),
            inputs_hash: g.bytes32(),
            finalized_slot: if finalized { g.u64() } else { 0 },
            has_proposal,
            proposed_epoch: g.u64(),
            proposed_value: g.u64(),
            proposed_inputs_hash: g.bytes32(),
            proposed_slot: g.u64(),
            dispute_window_slots: g.u64(),
            max_move_bps: g.u16(),
            history: [IndexPoint::default(); INDEX_HISTORY],
            history_head: 0,
            history_count: 0,
            _reserved: [0; 32],
        };
        let mut pushed = Vec::new();
        for i in 0..pushes {
            // Epochs 700.., with one repeat in "duplicate_epochs" so value_for's
            // first-match-in-array-order rule is pinned.
            let epoch = if label == "duplicate_epochs" && i == 3 {
                701
            } else {
                700 + i as u64
            };
            let point = IndexPoint {
                epoch,
                value: g.sized(),
            };
            pushed.push(point);
            a.push_history(point);
        }
        a.epoch = 700 + pushes as u64;
        let (data, len) = account_bytes(&a, None);
        // Probe value_for at the current epoch, every pushed epoch and a few misses.
        let mut probes: Vec<u64> = vec![0, 1, 699, a.epoch, a.epoch + 1, u64::MAX];
        probes.extend(pushed.iter().map(|p| p.epoch));
        probes.sort_unstable();
        probes.dedup();
        let value_for = J::Arr(
            probes
                .iter()
                .map(|e| obj(vec![("epoch", e.j()), ("value", a.value_for(*e).j())]))
                .collect(),
        );
        out.push(example(
            label,
            &data,
            len,
            fee_index_json(&a),
            vec![
                ("pushedHistory", J::Arr(pushed.iter().map(ToJ::j).collect())),
                ("valueFor", value_for),
            ],
        ));
    }
    out
}

fn quote_json(a: &FeeQuote) -> J {
    fields!(a, FeeQuote {
        pool, maker, epoch, fixed_rate, max_notional, filled_notional, max_move_bps, expiry_slot,
        collateral, locked_collateral, open_swaps, bump,
    } skip { _reserved })
}

fn quote_examples(g: &mut Gen) -> Vec<J> {
    (0..2)
        .map(|i| {
            let a = FeeQuote {
                pool: g.key(),
                maker: g.key(),
                epoch: g.u64(),
                fixed_rate: g.u64(),
                max_notional: g.u64(),
                filled_notional: g.u64(),
                max_move_bps: g.u16(),
                expiry_slot: g.u64(),
                collateral: g.u64(),
                locked_collateral: g.u64(),
                open_swaps: g.u32(),
                bump: g.u8(),
                _reserved: [0; 16],
            };
            let (data, len) = account_bytes(&a, None);
            example(&format!("quote_{i}"), &data, len, quote_json(&a), vec![])
        })
        .collect()
}

fn swap_json(a: &SwapPosition) -> J {
    fields!(a, SwapPosition {
        quote, taker, epoch, side, notional, fixed_rate, max_move_bps, collateral, settled, pnl,
        bump,
    } skip { _reserved })
}

fn swap_examples(g: &mut Gen) -> Vec<J> {
    [
        (Side::ReceiveFixed, true, -1_234_567_890i64),
        (Side::PayFixed, false, i64::MAX),
    ]
    .into_iter()
    .map(|(side, settled, pnl)| {
        let a = SwapPosition {
            quote: g.key(),
            taker: g.key(),
            epoch: g.u64(),
            side,
            notional: g.u64(),
            fixed_rate: g.u64(),
            max_move_bps: g.u16(),
            collateral: g.u64(),
            settled,
            pnl,
            bump: g.u8(),
            _reserved: [0; 16],
        };
        let (data, len) = account_bytes(&a, None);
        example(&format!("{side:?}"), &data, len, swap_json(&a), vec![])
    })
    .collect()
}

fn revenue_token_json(a: &RevenueToken) -> J {
    let fields = fields!(a, RevenueToken {
        pool, position, vote, operator, mint, token_program, dbc_pool, dbc_config,
    } skip {
        damm_pool, share_bps, term_epochs, registered_epoch, start_epoch, term_end_epoch,
        advance_seq_at_registration, inflation_commission_bps, block_commission_bps, bump,
        escrow_bump, tokens_bump, wsol_bump, slices_per_epoch, window_slots, max_slippage_bps,
        max_impact_bps, flags, status, buyback_epoch, epoch_budget, epoch_spent, slices_done,
        last_share_epoch, total_escrowed, total_spent, total_bought, total_burned, total_redeemed,
        total_redeemed_lamports, buyback_count, fee_floor_bps, _reserved,
    });
    let rest = fields!(a, RevenueToken {
        share_bps, term_epochs, registered_epoch, start_epoch, term_end_epoch,
        advance_seq_at_registration, inflation_commission_bps, block_commission_bps, bump,
        escrow_bump, tokens_bump, wsol_bump, slices_per_epoch, window_slots, max_slippage_bps,
        max_impact_bps, flags, status, buyback_epoch, epoch_budget, epoch_spent, slices_done,
        last_share_epoch, total_escrowed, total_spent, total_bought, total_burned, total_redeemed,
        total_redeemed_lamports, buyback_count, fee_floor_bps,
    } skip {
        pool, position, vote, operator, mint, token_program, dbc_pool, dbc_config, damm_pool,
        _reserved,
    });
    let mut out = with_field(fields, "damm_pool", optional_key(&a.damm_pool));
    if let (J::Obj(f), J::Obj(r)) = (&mut out, rest) {
        f.extend(r);
    }
    out
}

/// Revenue tokens use their own generator so the older sections keep their values.
fn revenue_token_examples(g: &mut Gen) -> Vec<J> {
    let mut out = Vec::new();
    for (label, graduated) in [("curve", false), ("graduated", true)] {
        let params = if graduated {
            BuybackParams {
                slices_per_epoch: 32,
                window_slots: g.u32(),
                max_slippage_bps: 2_000,
                max_impact_bps: 10,
                flags: FLAG_BUYBACKS_PAUSED | FLAG_REDEEM_DURING_TERM,
            }
        } else {
            BuybackParams::default()
        };
        let start = g.u64() >> 1;
        let a = RevenueToken {
            pool: g.key(),
            position: g.key(),
            vote: g.key(),
            operator: g.key(),
            mint: g.key(),
            token_program: TOKEN_PROGRAM_ID,
            dbc_pool: g.key(),
            dbc_config: g.key(),
            damm_pool: if graduated {
                g.key()
            } else {
                Pubkey::default()
            },
            share_bps: if graduated { MAX_SHARE_BPS } else { 1_000 },
            term_epochs: if graduated { MAX_TERM_EPOCHS } else { 52 },
            registered_epoch: start - 1,
            start_epoch: start,
            term_end_epoch: start + if graduated { 1_000 } else { 52 },
            advance_seq_at_registration: g.u64(),
            inflation_commission_bps: g.u16(),
            block_commission_bps: g.u16(),
            bump: g.u8(),
            escrow_bump: g.u8(),
            tokens_bump: g.u8(),
            wsol_bump: g.u8(),
            slices_per_epoch: params.slices_per_epoch,
            window_slots: params.window_slots,
            max_slippage_bps: params.max_slippage_bps,
            max_impact_bps: params.max_impact_bps,
            flags: params.flags,
            status: if graduated {
                RevenueTokenStatus::Graduated
            } else {
                RevenueTokenStatus::Curve
            },
            buyback_epoch: if graduated { g.u64() } else { 0 },
            epoch_budget: if graduated { g.u64() } else { 0 },
            epoch_spent: if graduated { g.sized() } else { 0 },
            slices_done: if graduated { g.u32() } else { 0 },
            last_share_epoch: if graduated { g.u64() } else { 0 },
            total_escrowed: g.u64(),
            total_spent: g.u64(),
            total_bought: g.u64(),
            total_burned: g.u64(),
            total_redeemed: g.u64(),
            total_redeemed_lamports: g.u64(),
            buyback_count: g.u32(),
            // Fixed values: the generator's sequence (and older vectors) stay put.
            fee_floor_bps: if graduated { 25 } else { 100 },
            _reserved: [0; 62],
        };
        let (data, len) = account_bytes(&a, None);
        out.push(example(label, &data, len, revenue_token_json(&a), vec![]));
    }
    out
}

// ─── Validator history (zero-copy) and ScoreConfig ─────────────────────────

/// A zero-copy account's bytes are its `repr(C)` struct after the discriminator: no Borsh.
fn zero_copy_bytes<T: Copy>(discriminator: &[u8], value: &T) -> Vec<u8> {
    // SAFETY: `T` is a `#[account(zero_copy)]` struct: `repr(C)`, `Pod`, no padding (pinned by
    // the program's own size tests), so every byte is initialized.
    let raw = unsafe {
        std::slice::from_raw_parts((value as *const T).cast::<u8>(), std::mem::size_of::<T>())
    };
    let mut out = discriminator.to_vec();
    out.extend_from_slice(raw);
    out
}

fn zero_copy_entry(name: &str, discriminator: &[u8], size: usize, examples: Vec<J>) -> (String, J) {
    (
        name.to_string(),
        obj(vec![
            ("discriminator", hex(discriminator)),
            ("initSpace", J::Int((size - 8) as i64)),
            ("size", J::Int(size as i64)),
            ("examples", J::Arr(examples)),
        ]),
    )
}

fn known32(v: u32) -> Option<u32> {
    (v != UNKNOWN_U32).then_some(v)
}

/// The SDK's view of an entry: sentinels (all ones) read as null, `superminority` as a bool.
fn history_entry_json(e: &HistoryEntry) -> J {
    let HistoryEntry {
        epoch,
        epoch_credits,
        max_credits,
        vote_lamports,
        revenue_lamports,
        mev_earned_lamports,
        priority_fees_lamports,
        activated_stake_lamports,
        last_voted_slot,
        updated_slot,
        rank,
        inflation_commission_bps,
        block_commission_bps,
        mev_commission_bps,
        priority_fee_commission_bps,
        superminority,
        sources,
        _reserved0: _,
        _reserved: _,
    } = *e;
    obj(vec![
        ("epoch", epoch.j()),
        ("epoch_credits", known_u64(epoch_credits).j()),
        ("max_credits", known_u64(max_credits).j()),
        ("vote_lamports", known_u64(vote_lamports).j()),
        ("revenue_lamports", known_u64(revenue_lamports).j()),
        ("mev_earned_lamports", known_u64(mev_earned_lamports).j()),
        (
            "priority_fees_lamports",
            known_u64(priority_fees_lamports).j(),
        ),
        (
            "activated_stake_lamports",
            known_u64(activated_stake_lamports).j(),
        ),
        ("last_voted_slot", known_u64(last_voted_slot).j()),
        ("updated_slot", known_u64(updated_slot).j()),
        ("rank", known32(rank).j()),
        (
            "inflation_commission_bps",
            known_u16(inflation_commission_bps).j(),
        ),
        ("block_commission_bps", known_u16(block_commission_bps).j()),
        ("mev_commission_bps", known_u16(mev_commission_bps).j()),
        (
            "priority_fee_commission_bps",
            known_u16(priority_fee_commission_bps).j(),
        ),
        (
            "superminority",
            match superminority {
                0 => J::Bool(false),
                1 => J::Bool(true),
                _ => J::Null,
            },
        ),
        ("sources", sources.j()),
    ])
}

/// Header fields plus the filled entries, oldest first (what `decodeValidatorHistory` returns).
fn history_json(h: &ValidatorHistory) -> J {
    let ValidatorHistory {
        vote,
        created_epoch,
        last_vote_copy_slot,
        refreshed_epoch,
        refreshed_slot,
        hedge_required_notional,
        epochs_voted,
        score,
        credits_ratio_bps,
        credits_ratio_raw_bps,
        commission_bps,
        epochs_active,
        bump,
        version,
        score_flags,
        _padding: _,
        _reserved: _,
        entries,
    } = *h;
    let mut filled: Vec<HistoryEntry> = entries
        .iter()
        .copied()
        .filter(|e| e.epoch != UNKNOWN_U64)
        .collect();
    filled.sort_by_key(|e| e.epoch);
    obj(vec![
        ("vote", vote.j()),
        ("created_epoch", created_epoch.j()),
        ("last_vote_copy_slot", last_vote_copy_slot.j()),
        ("refreshed_epoch", refreshed_epoch.j()),
        ("refreshed_slot", refreshed_slot.j()),
        ("hedge_required_notional", hedge_required_notional.j()),
        ("epochs_voted", epochs_voted.j()),
        ("score", score.j()),
        ("credits_ratio_bps", credits_ratio_bps.j()),
        ("credits_ratio_raw_bps", credits_ratio_raw_bps.j()),
        ("commission_bps", commission_bps.j()),
        ("epochs_active", epochs_active.j()),
        ("bump", bump.j()),
        ("version", version.j()),
        ("score_flags", score_flags.j()),
        (
            "entries",
            J::Arr(filled.iter().map(history_entry_json).collect()),
        ),
    ])
}

fn blank_history(vote: Pubkey, created_epoch: u64, bump: u8) -> ValidatorHistory {
    ValidatorHistory {
        vote,
        created_epoch,
        last_vote_copy_slot: 0,
        refreshed_epoch: 0,
        refreshed_slot: 0,
        hedge_required_notional: 0,
        epochs_voted: 0,
        score: 0,
        credits_ratio_bps: 0,
        credits_ratio_raw_bps: 0,
        commission_bps: 0,
        epochs_active: 0,
        bump,
        version: VALIDATOR_HISTORY_VERSION,
        score_flags: 0,
        _padding: 0,
        _reserved: [0; 64],
        entries: [HistoryEntry::EMPTY; HISTORY_LEN],
    }
}

fn history_examples(g: &mut Gen) -> Vec<J> {
    let mut out = Vec::new();

    // As `init_validator_history` leaves it: every entry unknown.
    let fresh = blank_history(g.key(), g.u64() >> 20, g.u8());
    let data = zero_copy_bytes(ValidatorHistory::DISCRIMINATOR, &fresh);
    out.push(example(
        "fresh",
        &data,
        data.len(),
        history_json(&fresh),
        vec![],
    ));

    // 70 epochs written through the program's own `entry_mut`, so the ring wraps and evicts
    // the oldest six; some fields stay unknown, some are copied, the oracle fills a few.
    let mut h = blank_history(g.key(), 1_000, g.u8());
    for epoch in 1_000u64..1_070 {
        let e = h.entry_mut(epoch).expect("entry_mut");
        e.epoch_credits = g.sized();
        e.max_credits = 432_000 * 16;
        e.sources |= SOURCE_CREDITS;
        if epoch % 3 == 0 {
            e.vote_lamports = g.u64();
            e.revenue_lamports = g.sized();
            e.last_voted_slot = g.u64() >> 8;
            e.updated_slot = g.u64() >> 8;
            e.inflation_commission_bps = g.u16() % 10_001;
            e.block_commission_bps = 10_000;
            e.sources |= SOURCE_VOTE;
        }
        if epoch % 4 == 0 {
            e.mev_commission_bps = g.u16() % 10_001;
            e.mev_earned_lamports = g.u64();
            e.sources |= SOURCE_TIP;
        }
        if epoch % 5 == 0 {
            e.priority_fee_commission_bps = 5_000;
            e.priority_fees_lamports = g.sized();
            e.sources |= SOURCE_PRIORITY_FEE;
        }
        if epoch % 7 == 0 {
            e.activated_stake_lamports = g.u64();
            e.rank = g.u32() % 2_000 + 1;
            e.superminority = u8::from(epoch % 2 == 0);
            e.sources |= SOURCE_STAKE;
        }
    }
    h.last_vote_copy_slot = g.u64() >> 8;
    h.refreshed_epoch = 1_069;
    h.refreshed_slot = g.u64() >> 8;
    h.hedge_required_notional = g.sized();
    h.epochs_voted = 64;
    h.score = g.u16() % 10_001;
    h.credits_ratio_bps = g.u16();
    h.credits_ratio_raw_bps = g.u16() % 10_001;
    h.commission_bps = g.u16() % 10_001;
    h.epochs_active = g.u16();
    h.set_flag(SCORE_FLAG_HEDGED, true);
    h.set_flag(SCORE_FLAG_SCORED, true);
    let data = zero_copy_bytes(ValidatorHistory::DISCRIMINATOR, &h);
    out.push(example(
        "wrapped",
        &data,
        data.len(),
        history_json(&h),
        vec![],
    ));
    out
}

fn score_config_json(a: &ScoreConfig) -> J {
    let ScoreConfig {
        pool,
        market_maker,
        credits_window_epochs,
        count_block_commission,
        credits_reference_bps,
        max_copy_age_slots,
        bump,
        _reserved: _,
    } = a;
    obj(vec![
        ("pool", pool.j()),
        (
            "market_maker",
            if *market_maker == Pubkey::default() {
                J::Null
            } else {
                market_maker.j()
            },
        ),
        ("credits_window_epochs", credits_window_epochs.j()),
        ("count_block_commission", count_block_commission.j()),
        ("credits_reference_bps", credits_reference_bps.j()),
        ("max_copy_age_slots", max_copy_age_slots.j()),
        ("bump", bump.j()),
    ])
}

fn score_config_examples(g: &mut Gen) -> Vec<J> {
    [
        ("maker_set", g.key(), true),
        ("no_maker", Pubkey::default(), false),
    ]
    .into_iter()
    .map(|(label, market_maker, count_block_commission)| {
        let a = ScoreConfig {
            pool: g.key(),
            market_maker,
            credits_window_epochs: g.u8(),
            count_block_commission,
            credits_reference_bps: g.u16(),
            max_copy_age_slots: g.u32(),
            bump: g.u8(),
            _reserved: [0; 64],
        };
        let (data, len) = account_bytes(&a, None);
        example(label, &data, len, score_config_json(&a), vec![])
    })
    .collect()
}

fn account_entry<T: Discriminator + Space>(name: &str, examples: Vec<J>) -> (String, J) {
    (
        name.to_string(),
        obj(vec![
            ("discriminator", hex(T::DISCRIMINATOR)),
            ("initSpace", J::Int(T::INIT_SPACE as i64)),
            ("size", J::Int((8 + T::INIT_SPACE) as i64)),
            ("examples", J::Arr(examples)),
        ]),
    )
}

fn accounts(g: &mut Gen, g2: &mut Gen, g4: &mut Gen) -> J {
    J::Obj(vec![
        account_entry::<Pool>("Pool", pool_examples(g)),
        account_entry::<LenderShares>("LenderShares", lender_examples(g)),
        account_entry::<WithdrawRequest>("WithdrawRequest", withdraw_examples(g)),
        account_entry::<ValidatorPosition>("ValidatorPosition", position_examples(g)),
        account_entry::<Advance>("Advance", advance_examples(g)),
        account_entry::<FeeIndex>("FeeIndex", fee_index_examples(g)),
        account_entry::<FeeQuote>("FeeQuote", quote_examples(g)),
        account_entry::<SwapPosition>("SwapPosition", swap_examples(g)),
        account_entry::<RevenueToken>("RevenueToken", revenue_token_examples(g2)),
        zero_copy_entry(
            "ValidatorHistory",
            ValidatorHistory::DISCRIMINATOR,
            ValidatorHistory::SPACE,
            history_examples(g4),
        ),
        account_entry::<ScoreConfig>("ScoreConfig", score_config_examples(g4)),
    ])
}

// ─── Events ────────────────────────────────────────────────────────────────

fn event_entry<E: Event>(name: &str, label: &str, e: &E, fields: J) -> J {
    obj(vec![
        ("name", s(name)),
        ("label", s(label)),
        ("discriminator", hex(E::DISCRIMINATOR)),
        ("data", hex(&e.data())),
        ("fields", fields),
    ])
}

/// `field: value` or the shorthand `field` (rustfmt rewrites `x: x` to `x` inside macro calls).
macro_rules! pick {
    ($f:ident) => {
        $f
    };
    ($f:ident, $v:expr) => {
        $v
    };
}

macro_rules! event {
    ($out:expr, $label:expr, $name:ident { $($f:ident $(: $v:expr)?),* $(,)? }) => {{
        let e = $name { $($f: pick!($f $(, $v)?)),* };
        let fields = fields!(&e, $name { $($f),* } skip {});
        $out.push(event_entry(stringify!($name), $label, &e, fields));
    }};
}

fn events(g: &mut Gen, g2: &mut Gen, g3: &mut Gen, g4: &mut Gen) -> J {
    let mut out = Vec::new();
    for (label, flag) in [("a", true), ("b", false)] {
        let tranche = if flag {
            Tranche::Junior
        } else {
            Tranche::Senior
        };
        let side = if flag {
            Side::ReceiveFixed
        } else {
            Side::PayFixed
        };
        event!(
            out,
            label,
            PoolInitialized {
                pool: g.key(),
                admin: g.key(),
                treasury: g.key(),
                scorer: g.key()
            }
        );
        event!(out, label, ParamsUpdated { pool: g.key() });
        event!(
            out,
            label,
            PauseToggled {
                pool: g.key(),
                paused: flag
            }
        );
        event!(
            out,
            label,
            Deposited {
                pool: g.key(),
                owner: g.key(),
                tranche,
                assets: g.u64(),
                shares: g.u64(),
                share_price_e9: g.u64(),
            }
        );
        event!(
            out,
            label,
            WithdrawRequested {
                pool: g.key(),
                owner: g.key(),
                tranche,
                shares: g.u64(),
                seq: g.u64()
            }
        );
        event!(
            out,
            label,
            WithdrawCancelled {
                pool: g.key(),
                owner: g.key(),
                seq: g.u64(),
                reason: u8::from(flag)
            }
        );
        event!(
            out,
            label,
            WithdrawProcessed {
                pool: g.key(),
                owner: g.key(),
                tranche,
                shares: g.u64(),
                assets: g.u64(),
                seq: g.u64(),
            }
        );
        event!(
            out,
            label,
            Accrued {
                pool: g.key(),
                epoch: g.u64(),
                income: g.u64(),
                protocol_fee: g.u64(),
                senior_gain: g.u64(),
                junior_gain: g.u64(),
                senior_price_e9: g.u64(),
                junior_price_e9: g.u64(),
            }
        );
        event!(
            out,
            label,
            ValidatorOnboarded {
                pool: g.key(),
                vote: g.key(),
                identity: g.key(),
                operator: g.key(),
                original_withdrawer: g.key(),
                epoch: g.u64(),
            }
        );
        event!(
            out,
            label,
            CollectorsSet {
                vote: g.key(),
                collector: g.key()
            }
        );
        event!(
            out,
            label,
            ScoreUpdated {
                vote: g.key(),
                epoch: g.u64(),
                score: g.u16(),
                hedged: flag
            }
        );
        event!(
            out,
            label,
            BondPosted {
                vote: g.key(),
                lamports: g.u64(),
                bond_total: g.u64()
            }
        );
        event!(
            out,
            label,
            BondWithdrawn {
                vote: g.key(),
                lamports: g.u64(),
                bond_total: g.u64()
            }
        );
        event!(
            out,
            label,
            AdvanceOpened {
                pool: g.key(),
                vote: g.key(),
                advance: g.key(),
                seq: g.u64(),
                principal: g.u64(),
                fee: g.u64(),
                remit_bps: g.u16(),
                epoch: g.u64(),
            }
        );
        event!(
            out,
            label,
            Swept {
                pool: g.key(),
                vote: g.key(),
                epoch: g.u64(),
                from_vote: g.u64(),
                gross: g.u64(),
                remitted: g.u64(),
                to_operator: g.u64(),
            }
        );
        event!(
            out,
            label,
            AdvanceRepaid {
                vote: g.key(),
                advance: g.key(),
                epoch: g.u64()
            }
        );
        event!(
            out,
            label,
            AdvanceDefaulted {
                pool: g.key(),
                vote: g.key(),
                advance: g.key(),
                principal_lost: g.u64(),
                bond_applied: g.u64(),
                epoch: g.u64(),
            }
        );
        event!(
            out,
            label,
            CommissionUpdated {
                vote: g.key(),
                kind: u8::from(flag),
                commission_bps: g.u16()
            }
        );
        event!(
            out,
            label,
            IdentityUpdated {
                vote: g.key(),
                new_identity: g.key()
            }
        );
        event!(
            out,
            label,
            ValidatorReleased {
                pool: g.key(),
                vote: g.key(),
                new_withdrawer: g.key(),
                epoch: g.u64()
            }
        );
        event!(
            out,
            label,
            IndexProposed {
                epoch: g.u64(),
                value: g.u64(),
                inputs_hash: g.bytes32(),
                slot: g.u64()
            }
        );
        event!(
            out,
            label,
            IndexFinalized {
                epoch: g.u64(),
                value: g.u64(),
                inputs_hash: g.bytes32(),
                slot: g.u64()
            }
        );
        event!(
            out,
            label,
            IndexVetoed {
                epoch: g.u64(),
                value: g.u64()
            }
        );
        event!(
            out,
            label,
            QuotePosted {
                quote: g.key(),
                maker: g.key(),
                epoch: g.u64(),
                fixed_rate: g.u64(),
                max_notional: g.u64(),
                max_move_bps: g.u16(),
            }
        );
        event!(
            out,
            label,
            SwapOpened {
                quote: g.key(),
                swap: g.key(),
                taker: g.key(),
                epoch: g.u64(),
                side,
                notional: g.u64(),
                fixed_rate: g.u64(),
                collateral: g.u64(),
            }
        );
        event!(
            out,
            label,
            SwapSettled {
                swap: g.key(),
                epoch: g.u64(),
                index_value: g.u64(),
                taker_pnl: if flag {
                    g.i64().min(-1)
                } else {
                    g.i64().max(1)
                },
            }
        );
    }
    // Revenue tokens: their own generator, so the events above keep their values.
    let g = g2;
    for (label, flag) in [("a", true), ("b", false)] {
        event!(
            out,
            label,
            RevenueTokenRegistered {
                pool: g.key(),
                vote: g.key(),
                revenue_token: g.key(),
                mint: g.key(),
                dbc_pool: g.key(),
                share_bps: g.u16(),
                term_epochs: g.u16(),
                start_epoch: g.u64(),
                term_end_epoch: g.u64(),
                inflation_commission_bps: g.u16(),
                block_commission_bps: g.u16(),
            }
        );
        event!(
            out,
            label,
            RevenueShareSwept {
                vote: g.key(),
                mint: g.key(),
                epoch: g.u64(),
                gross: g.u64(),
                share: g.sized(),
                after_senior_advance: flag,
                escrow_balance: g.u64(),
            }
        );
        event!(
            out,
            label,
            RevenueTokenPoolSynced {
                vote: g.key(),
                mint: g.key(),
                dbc_pool: g.key(),
                damm_pool: g.key(),
                damm_config: g.key(),
            }
        );
        event!(
            out,
            label,
            BuybackExecuted {
                vote: g.key(),
                mint: g.key(),
                venue: if flag {
                    BuybackVenue::Dbc
                } else {
                    BuybackVenue::DammV2
                },
                epoch: g.u64(),
                slice: g.u8(),
                lamports_in: g.u64(),
                tokens_bought: g.u64(),
                tokens_burned: g.u64(),
                min_amount_out: g.sized(),
                fee_free_out: g.u64(),
                escrow_balance: g.sized(),
            }
        );
        event!(
            out,
            label,
            RevenueTokenRedeemed {
                vote: g.key(),
                mint: g.key(),
                holder: g.key(),
                tokens_burned: g.u64(),
                lamports_out: g.sized(),
                circulating_supply: g.u64(),
                epoch: g.u64(),
            }
        );
        event!(
            out,
            label,
            RevenueTokenConfigured {
                vote: g.key(),
                slices_per_epoch: g.u8(),
                window_slots: g.u32(),
                max_slippage_bps: g.u16(),
                max_impact_bps: g.u16(),
                flags: g.u8(),
            }
        );
        event!(
            out,
            label,
            RevenueTokenClosed {
                vote: g.key(),
                mint: g.key(),
                total_escrowed: g.u64(),
                total_spent: g.u64(),
                total_burned: g.u64(),
                total_redeemed: g.sized(),
                lamports_to_pool: 4_200_000_017,
            }
        );
    }
    // Treasury claims (added later): their own sequence, so earlier vectors keep their values.
    let g = g3;
    for (label, kind) in [
        ("trading_fee", TreasuryClaimKind::TradingFee),
        ("surplus", TreasuryClaimKind::Surplus),
        ("migration_fee", TreasuryClaimKind::MigrationFee),
        ("leftover", TreasuryClaimKind::Leftover),
        ("lp_fee", TreasuryClaimKind::LpFee),
    ] {
        event!(
            out,
            label,
            TreasuryClaimed {
                pool: g.key(),
                kind,
                mint: g.key(),
                source: g.key(),
                position: if kind == TreasuryClaimKind::LpFee {
                    g.key()
                } else {
                    Pubkey::default()
                },
                cranker: g.key(),
                lamports_claimed: g.u64(),
                lamports_to_pool: g.sized(),
                tokens_claimed: g.u64(),
                tokens_burned: g.sized(),
                pool_cash: g.u64(),
                income_unallocated: g.sized(),
            }
        );
    }
    // Validator history (a fourth sequence, so every older vector keeps its bytes).
    for (label, flag) in [("a", true), ("b", false)] {
        event!(
            out,
            label,
            HistoryInitialized {
                vote: g4.key(),
                history: g4.key(),
                payer: g4.key(),
                epoch: g4.u64()
            }
        );
        event!(
            out,
            label,
            VoteAccountCopied {
                vote: g4.key(),
                epoch: g4.u64(),
                slot: g4.u64(),
                epoch_credits: g4.sized(),
                epochs_backfilled: g4.u8(),
                last_voted_slot: if flag { Some(g4.u64()) } else { None },
                inflation_commission_bps: g4.u16(),
                block_commission_bps: g4.u16(),
                vote_lamports: g4.u64(),
                revenue_lamports: g4.sized(),
            }
        );
        event!(
            out,
            label,
            TipDistributionCopied {
                vote: g4.key(),
                epoch: g4.u64(),
                found: flag,
                mev_commission_bps: if flag { Some(g4.u16()) } else { None },
                mev_earned_lamports: if flag { Some(g4.u64()) } else { None },
            }
        );
        event!(
            out,
            label,
            PriorityFeeDistributionCopied {
                vote: g4.key(),
                epoch: g4.u64(),
                found: flag,
                priority_fee_commission_bps: if flag { Some(g4.u16()) } else { None },
                priority_fees_lamports: if flag { Some(g4.sized()) } else { None },
            }
        );
        event!(
            out,
            label,
            StakeInfoUpdated {
                vote: g4.key(),
                epoch: g4.u64(),
                activated_stake_lamports: g4.u64(),
                rank: g4.u32(),
                superminority: flag,
            }
        );
        event!(
            out,
            label,
            ScoreRefreshed {
                pool: g4.key(),
                vote: g4.key(),
                epoch: g4.u64(),
                score: g4.u16(),
                credits_ratio_bps: g4.u16(),
                credits_ratio_raw_bps: g4.u16(),
                commission_bps: g4.u16(),
                epochs_active: g4.u16(),
                delinquent: flag,
                superminority: !flag,
                hedged: flag,
                hedge_required_notional: g4.sized(),
            }
        );
        event!(
            out,
            label,
            ScoringConfigured {
                pool: g4.key(),
                market_maker: g4.key(),
                credits_window_epochs: g4.u8(),
                count_block_commission: flag,
                credits_reference_bps: g4.u16(),
                max_copy_age_slots: g4.u32(),
            }
        );
    }
    J::Arr(out)
}

// ─── Instructions ──────────────────────────────────────────────────────────

fn metas_json(metas: &[AccountMeta]) -> J {
    J::Arr(
        metas
            .iter()
            .map(|m| {
                obj(vec![
                    ("pubkey", m.pubkey.j()),
                    ("isSigner", J::Bool(m.is_signer)),
                    ("isWritable", J::Bool(m.is_writable)),
                ])
            })
            .collect(),
    )
}

struct Ix {
    name: &'static str,
    label: String,
    program_id: Pubkey,
    discriminator: Vec<u8>,
    data: Vec<u8>,
    args: J,
    accounts: J,
    context: J,
    metas: Vec<AccountMeta>,
}

impl Ix {
    fn json(self) -> J {
        obj(vec![
            ("name", s(self.name)),
            ("label", s(self.label)),
            ("programId", self.program_id.j()),
            ("discriminator", hex(&self.discriminator)),
            ("data", hex(&self.data)),
            ("args", self.args),
            ("accounts", self.accounts),
            ("context", self.context),
            ("metas", metas_json(&self.metas)),
        ])
    }
}

/// Build one vector from the program's own `instruction::X` (data) and `accounts::X` (metas).
macro_rules! ix {
    (
        $out:expr, $pid:expr, $name:literal, $label:expr,
        $ix:ident $({ $($a:ident $(: $av:expr)?),* $(,)? })?,
        $acc:ident { $($f:ident $(: $fv:expr)?),* $(,)? },
        context { $($c:ident $(: $cv:expr)?),* $(,)? }
    ) => {{
        let ix_data = epoch::instruction::$ix $({ $($a: pick!($a $(, $av)?)),* })?;
        let args: Vec<(&str, J)> = vec![$($((stringify!($a), ToJ::j(&ix_data.$a))),*)?];
        let accs = epoch::accounts::$acc { $($f: pick!($f $(, $fv)?)),* };
        let accounts = fields!(&accs, epoch::accounts::$acc { $($f),* } skip {});
        let context: Vec<(&str, J)> = vec![$((stringify!($c), ToJ::j(&pick!($c $(, $cv)?)))),*];
        $out.push(Ix {
            name: $name,
            label: $label.to_string(),
            program_id: $pid,
            discriminator: <epoch::instruction::$ix as Discriminator>::DISCRIMINATOR.to_vec(),
            data: ix_data.data(),
            args: obj(args),
            accounts,
            context: obj(context),
            metas: accs.to_account_metas(None),
        });
    }};
}

const CLOCK: Pubkey = pubkey!("SysvarC1ock11111111111111111111111111111111");

fn instructions(g: &mut Gen, pid: Pubkey) -> Vec<Ix> {
    let system = anchor_lang::solana_program::system_program::ID;
    let (admin, treasury, scorer, new_admin) = (k(1), k(2), k(3), k(4));
    let (owner, cranker, operator, current_withdrawer) = (k(5), k(6), k(7), k(8));
    let (vote, payout, new_withdrawer, identity) = (k(9), k(10), k(11), k(12));
    let (new_identity, publisher, maker, taker) = (k(13), k(14), k(15), k(16));
    let (advance_key, open_advance, quote_key) = (k(17), k(18), k(19));

    let pool = addr(&[POOL_SEED], &pid);
    let vault = addr(&[VAULT_SEED, pool.as_ref()], &pid);
    let position = addr(&[POSITION_SEED, vote.as_ref()], &pid);
    let vote_auth = addr(&[VOTE_AUTH_SEED, vote.as_ref()], &pid);
    let escrow = addr(&[ESCROW_SEED, vote.as_ref()], &pid);
    let history = addr(&[HISTORY_SEED, vote.as_ref()], &pid);
    let fee_index = addr(&[FEE_INDEX_SEED, pool.as_ref()], &pid);
    let lender = |owner: Pubkey, t: Tranche| {
        addr(
            &[LENDER_SEED, pool.as_ref(), owner.as_ref(), &[t.as_u8()]],
            &pid,
        )
    };
    let request = |seq: u64| addr(&[WITHDRAW_SEED, pool.as_ref(), &seq.to_le_bytes()], &pid);
    let advance = |seq: u64| addr(&[ADVANCE_SEED, vote.as_ref(), &seq.to_le_bytes()], &pid);
    let quote =
        |maker: Pubkey, epoch: u64| addr(&[QUOTE_SEED, maker.as_ref(), &epoch.to_le_bytes()], &pid);
    let swap =
        |quote: Pubkey, taker: Pubkey| addr(&[SWAP_SEED, quote.as_ref(), taker.as_ref()], &pid);
    let revenue_token = addr(&[REVENUE_TOKEN_SEED, vote.as_ref()], &pid);
    let buyback_escrow = addr(&[BUYBACK_SEED, vote.as_ref()], &pid);

    let mut out: Vec<Ix> = Vec::new();

    ix!(
        out,
        pid,
        "initialize_pool",
        "default",
        InitializePool {
            params: pool_params(g)
        },
        InitializePool {
            admin,
            pool,
            vault,
            treasury,
            scorer,
            system_program: system
        },
        context {}
    );
    ix!(
        out,
        pid,
        "update_params",
        "default",
        UpdateParams {
            params: pool_params(g)
        },
        AdminOnly { admin, pool },
        context {}
    );
    for paused in [true, false] {
        ix!(
            out,
            pid,
            "set_paused",
            format!("paused_{paused}"),
            SetPaused { paused },
            AdminOnly { admin, pool },
            context {}
        );
    }
    ix!(
        out,
        pid,
        "set_roles",
        "default",
        SetRoles,
        SetRoles {
            admin,
            pool,
            treasury,
            scorer,
            new_admin
        },
        context {}
    );

    for (tranche, assets) in [
        (Tranche::Senior, 1_000_000_000u64),
        (Tranche::Junior, u64::MAX - 5),
    ] {
        ix!(
            out,
            pid,
            "deposit",
            format!("{tranche:?}"),
            Deposit { tranche, assets },
            Deposit {
                owner,
                pool,
                vault,
                lender: lender(owner, tranche),
                system_program: system
            },
            context {}
        );
    }
    for (tranche, shares, tail) in [
        (Tranche::Senior, 1_000_000_000_000u64, 0u64),
        (Tranche::Junior, g.u64(), (1 << 40) + 3),
    ] {
        ix!(
            out,
            pid,
            "request_withdraw",
            format!("{tranche:?}"),
            RequestWithdraw { shares },
            RequestWithdraw {
                owner,
                pool,
                lender: lender(owner, tranche),
                request: request(tail),
                system_program: system,
            },
            context {
                tranche,
                withdraw_tail: tail
            }
        );
    }
    for (tranche, seq) in [(Tranche::Junior, 7u64), (Tranche::Senior, u64::MAX)] {
        ix!(
            out,
            pid,
            "cancel_withdraw",
            format!("{tranche:?}"),
            CancelWithdraw,
            CancelWithdraw {
                owner,
                pool,
                lender: lender(owner, tranche),
                request: request(seq)
            },
            context { tranche, seq }
        );
        ix!(
            out,
            pid,
            "process_withdrawal",
            format!("{tranche:?}"),
            ProcessWithdrawal,
            ProcessWithdrawal {
                cranker,
                pool,
                vault,
                owner,
                lender: lender(owner, tranche),
                request: request(seq),
                system_program: system,
            },
            context { tranche, seq }
        );
    }
    ix!(
        out,
        pid,
        "accrue",
        "default",
        Accrue,
        Accrue {
            cranker,
            pool,
            vault,
            treasury,
            system_program: system
        },
        context {}
    );

    ix!(
        out,
        pid,
        "onboard_validator",
        "default",
        OnboardValidator,
        OnboardValidator {
            operator,
            current_withdrawer,
            pool,
            vote_account: vote,
            position,
            vote_auth,
            escrow,
            payout,
            clock: CLOCK,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "set_collectors",
        "default",
        SetCollectors,
        SetCollectors {
            cranker,
            position,
            vote_account: vote,
            vote_auth,
            escrow,
            vote_program: VOTE_PROGRAM_ID,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "update_score",
        "default",
        UpdateScore {
            update: ScoreUpdate {
                credits_ratio_bps: 9_812,
                commission_bps: 500,
                epochs_active: 77,
                delinquent: false,
                superminority: true,
                hedged: true,
            },
        },
        UpdateScore {
            scorer,
            pool,
            position,
            history
        },
        context { vote }
    );
    ix!(
        out,
        pid,
        "update_score",
        "flags_inverted",
        UpdateScore {
            update: ScoreUpdate {
                credits_ratio_bps: u16::MAX,
                commission_bps: 0,
                epochs_active: 1,
                delinquent: true,
                superminority: false,
                hedged: false,
            },
        },
        UpdateScore {
            scorer,
            pool,
            position,
            history
        },
        context { vote }
    );
    ix!(
        out,
        pid,
        "post_bond",
        "default",
        PostBond {
            lamports: 2_500_000_000
        },
        Bond {
            operator,
            pool,
            vault,
            position,
            system_program: system
        },
        context { vote }
    );
    ix!(
        out,
        pid,
        "withdraw_bond",
        "default",
        WithdrawBond { lamports: g.u64() },
        Bond {
            operator,
            pool,
            vault,
            position,
            system_program: system
        },
        context { vote }
    );
    for seq in [0u64, 3, u64::MAX - 1] {
        ix!(
            out,
            pid,
            "request_advance",
            format!("seq_{seq}"),
            RequestAdvance { amount: g.u64() },
            RequestAdvance {
                operator,
                pool,
                vault,
                position,
                advance: advance(seq),
                payout,
                system_program: system,
            },
            context {
                vote,
                advance_seq: seq
            }
        );
    }
    ix!(
        out,
        pid,
        "sweep",
        "advance_some",
        Sweep,
        Sweep {
            cranker,
            pool,
            vault,
            position,
            vote_account: vote,
            vote_auth,
            escrow,
            payout,
            advance: Some(open_advance),
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
            revenue_token: Some(revenue_token),
            buyback_escrow: Some(buyback_escrow),
        },
        context {}
    );
    // Anchor's Rust client fills an absent optional account with the compile-time `crate::ID`
    // (`declare_id!`, the placeholder 1111…1111 here); the program checks the runtime program id.
    ix!(
        out,
        pid,
        "sweep",
        "advance_none",
        Sweep,
        Sweep {
            cranker,
            pool,
            vault,
            position,
            vote_account: vote,
            vote_auth,
            escrow,
            payout,
            advance: None,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
            revenue_token: Some(revenue_token),
            buyback_escrow: Some(buyback_escrow),
        },
        context {}
    );
    ix!(
        out,
        pid,
        "mark_default",
        "default",
        MarkDefault,
        MarkDefault {
            cranker,
            pool,
            position,
            advance: advance_key
        },
        context { vote }
    );
    ix!(
        out,
        pid,
        "release_validator",
        "default",
        ReleaseValidator,
        ReleaseValidator {
            operator,
            pool,
            vault,
            position,
            vote_account: vote,
            vote_auth,
            escrow,
            new_withdrawer,
            identity,
            clock: CLOCK,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
            revenue_token: Some(revenue_token),
        },
        context {}
    );
    // kind_1 has no revenue token: its optional slot is `None` (see `revenue_instructions`).
    for (kind, bps, token) in [(0u8, 500u16, Some(revenue_token)), (1, 10_000, None)] {
        ix!(
            out,
            pid,
            "update_commission",
            format!("kind_{kind}"),
            UpdateCommission {
                kind,
                commission_bps: bps
            },
            UpdateCommission {
                operator,
                pool,
                position,
                vote_account: vote,
                vote_auth,
                vote_program: VOTE_PROGRAM_ID,
                revenue_token: token,
            },
            context {}
        );
    }
    ix!(
        out,
        pid,
        "update_identity",
        "default",
        UpdateIdentity,
        UpdateIdentity {
            operator,
            new_identity,
            position,
            vote_account: vote,
            vote_auth,
            vote_program: VOTE_PROGRAM_ID,
        },
        context {}
    );

    ix!(
        out,
        pid,
        "initialize_index",
        "default",
        InitializeIndex {
            dispute_window_slots: 150,
            max_move_bps: 2_000
        },
        InitializeIndex {
            admin,
            pool,
            fee_index,
            publisher,
            system_program: system
        },
        context {}
    );
    ix!(
        out,
        pid,
        "configure_index",
        "default",
        ConfigureIndex {
            dispute_window_slots: g.u64(),
            max_move_bps: g.u16()
        },
        ConfigureIndex {
            admin,
            pool,
            fee_index,
            publisher
        },
        context {}
    );
    ix!(
        out,
        pid,
        "post_index",
        "default",
        PostIndex {
            epoch: 812,
            value: g.u64(),
            inputs_hash: g.bytes32()
        },
        PostIndex {
            publisher,
            fee_index
        },
        context {}
    );
    ix!(
        out,
        pid,
        "finalize_index",
        "default",
        FinalizeIndex,
        FinalizeIndex { cranker, fee_index },
        context {}
    );
    ix!(
        out,
        pid,
        "veto_index",
        "default",
        VetoIndex,
        VetoIndex {
            admin,
            pool,
            fee_index
        },
        context {}
    );

    for epoch in [813u64, u64::MAX] {
        ix!(
            out,
            pid,
            "post_quote",
            format!("epoch_{epoch}"),
            PostQuote {
                epoch,
                fixed_rate: g.u64(),
                max_notional: g.u64(),
                max_move_bps: g.u16(),
                expiry_slot: g.u64(),
            },
            PostQuote {
                maker,
                pool,
                fee_index,
                quote: quote(maker, epoch),
                system_program: system,
            },
            context {}
        );
        ix!(
            out,
            pid,
            "withdraw_quote",
            format!("epoch_{epoch}"),
            WithdrawQuote,
            WithdrawQuote {
                maker,
                fee_index,
                quote: quote(maker, epoch)
            },
            context { epoch }
        );
    }
    for side in [Side::PayFixed, Side::ReceiveFixed] {
        ix!(
            out,
            pid,
            "open_swap",
            format!("{side:?}"),
            OpenSwap {
                notional: g.u64(),
                side
            },
            OpenSwap {
                taker,
                pool,
                fee_index,
                quote: quote_key,
                swap: swap(quote_key, taker),
                system_program: system,
            },
            context {}
        );
    }
    ix!(
        out,
        pid,
        "settle_swap",
        "default",
        SettleSwap,
        SettleSwap {
            cranker,
            fee_index,
            quote: quote_key,
            taker,
            swap: swap(quote_key, taker),
        },
        context {}
    );
    out
}

/// The same `sweep` with no advance, but derived under the declared program id, so the Rust
/// client's `crate::ID` placeholder and the SDK's `programId` placeholder coincide.
// ─── Validator history instructions ────────────────────────────────────────

fn history_instructions(g: &mut Gen, pid: Pubkey) -> Vec<Ix> {
    let system = anchor_lang::solana_program::system_program::ID;
    let (admin, scorer, cranker, operator, maker) = (k(1), k(3), k(6), k(7), k(15));
    let vote = k(9);
    let pool = addr(&[POOL_SEED], &pid);
    let position = addr(&[POSITION_SEED, vote.as_ref()], &pid);
    let escrow = addr(&[ESCROW_SEED, vote.as_ref()], &pid);
    let history = addr(&[HISTORY_SEED, vote.as_ref()], &pid);
    let score_config = addr(&[SCORE_CONFIG_SEED, pool.as_ref()], &pid);
    let jito = |program: Pubkey, seed: &[u8], epoch: u64| {
        addr(&[seed, vote.as_ref(), &epoch.to_le_bytes()], &program)
    };
    let mut out: Vec<Ix> = Vec::new();

    ix!(
        out,
        pid,
        "init_validator_history",
        "default",
        InitValidatorHistory,
        InitValidatorHistory {
            payer: cranker,
            vote_account: vote,
            history,
            system_program: system
        },
        context { vote }
    );
    ix!(
        out,
        pid,
        "copy_vote_account",
        "default",
        CopyVoteAccount,
        CopyVoteAccount {
            cranker,
            history,
            vote_account: vote,
            escrow
        },
        context { vote }
    );
    for (label, epoch) in [("small", 7u64), ("large", g.u64())] {
        let tip_distribution_account = jito(
            JITO_TIP_DISTRIBUTION_PROGRAM_ID,
            TIP_DISTRIBUTION_ACCOUNT_SEED,
            epoch,
        );
        ix!(
            out,
            pid,
            "copy_tip_distribution_account",
            label,
            CopyTipDistributionAccount { epoch },
            CopyTipDistribution {
                cranker,
                history,
                tip_distribution_account
            },
            context { vote }
        );
        let distribution_account = jito(
            JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
            PF_DISTRIBUTION_ACCOUNT_SEED,
            epoch,
        );
        ix!(
            out,
            pid,
            "copy_priority_fee_distribution",
            label,
            CopyPriorityFeeDistribution { epoch },
            CopyPriorityFeeDistribution {
                cranker,
                history,
                distribution_account
            },
            context { vote }
        );
    }
    for (label, superminority) in [("superminority", true), ("not_superminority", false)] {
        ix!(
            out,
            pid,
            "update_stake_info",
            label,
            UpdateStakeInfo {
                epoch: g.u64(),
                activated_stake_lamports: g.u64(),
                rank: g.u32(),
                superminority,
            },
            UpdateStakeInfo {
                scorer,
                pool,
                history
            },
            context { vote }
        );
    }
    for (label, params) in [
        (
            "maker_set",
            ScoringParams {
                market_maker: maker,
                credits_window_epochs: g.u8(),
                count_block_commission: true,
                credits_reference_bps: g.u16(),
                max_copy_age_slots: g.u32(),
            },
        ),
        (
            "no_maker",
            ScoringParams {
                market_maker: Pubkey::default(),
                credits_window_epochs: 10,
                count_block_commission: false,
                credits_reference_bps: DEFAULT_CREDITS_REFERENCE_BPS,
                max_copy_age_slots: DEFAULT_MAX_COPY_AGE_SLOTS,
            },
        ),
    ] {
        ix!(
            out,
            pid,
            "configure_scoring",
            label,
            ConfigureScoring { params },
            ConfigureScoring {
                admin,
                pool,
                score_config,
                system_program: system
            },
            context {}
        );
    }

    // refresh_score: the program derives the operator's swap on the maker's quote for each of
    // the next HEDGE_EPOCHS_AHEAD epochs and requires exactly those as remaining accounts.
    for (label, market_maker, current_epoch) in [
        ("maker_set", Some(maker), g.u64() >> 2),
        ("no_maker", None, 1_051u64),
    ] {
        ix!(
            out,
            pid,
            "refresh_score",
            label,
            RefreshScore,
            RefreshScore {
                cranker,
                pool,
                score_config,
                position,
                history
            },
            context {
                vote,
                operator,
                current_epoch,
                market_maker
            }
        );
        if let (Some(m), Some(ix)) = (market_maker, out.last_mut()) {
            for i in 1..=HEDGE_EPOCHS_AHEAD {
                let quote = addr(
                    &[QUOTE_SEED, m.as_ref(), &(current_epoch + i).to_le_bytes()],
                    &pid,
                );
                let swap = addr(&[SWAP_SEED, quote.as_ref(), operator.as_ref()], &pid);
                ix.metas.push(AccountMeta::new_readonly(swap, false));
            }
        }
    }
    out
}

fn sweep_declared_id() -> Ix {
    let pid = epoch::ID;
    let system = anchor_lang::solana_program::system_program::ID;
    let (cranker, vote, payout) = (k(6), k(9), k(10));
    let pool = addr(&[POOL_SEED], &pid);
    let mut out = Vec::new();
    ix!(
        out,
        pid,
        "sweep",
        "advance_none_declared_id",
        Sweep,
        Sweep {
            cranker,
            pool,
            vault: addr(&[VAULT_SEED, pool.as_ref()], &pid),
            position: addr(&[POSITION_SEED, vote.as_ref()], &pid),
            vote_account: vote,
            vote_auth: addr(&[VOTE_AUTH_SEED, vote.as_ref()], &pid),
            escrow: addr(&[ESCROW_SEED, vote.as_ref()], &pid),
            payout,
            advance: None,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
            revenue_token: None,
            buyback_escrow: None,
        },
        context {}
    );
    out.pop().expect("one vector")
}

/// The revenue-token instructions (and the `None` revenue-token cases of `sweep` and
/// `release_validator`). Their own generator keeps the older sections' values.
fn revenue_instructions(g: &mut Gen, pid: Pubkey) -> Vec<Ix> {
    let system = anchor_lang::solana_program::system_program::ID;
    let (admin, cranker, operator, vote, payout) = (k(1), k(6), k(7), k(9), k(10));
    let (new_withdrawer, identity, open_advance) = (k(11), k(12), k(18));
    let (mint, dbc_pool, dbc_config, damm_pool, damm_config) = (k(32), k(33), k(34), k(35), k(36));
    let (holder, holder_tokens) = (k(37), k(38));

    let pool = addr(&[POOL_SEED], &pid);
    let vault = addr(&[VAULT_SEED, pool.as_ref()], &pid);
    let position = addr(&[POSITION_SEED, vote.as_ref()], &pid);
    let vote_auth = addr(&[VOTE_AUTH_SEED, vote.as_ref()], &pid);
    let escrow = addr(&[ESCROW_SEED, vote.as_ref()], &pid);
    let revenue_token = addr(&[REVENUE_TOKEN_SEED, vote.as_ref()], &pid);
    let buyback_escrow = addr(&[BUYBACK_SEED, vote.as_ref()], &pid);
    let buyback_wsol = addr(&[BUYBACK_WSOL_SEED, vote.as_ref()], &pid);
    let buyback_tokens = addr(&[BUYBACK_TOKENS_SEED, vote.as_ref()], &pid);
    let partner_treasury = addr(&[PARTNER_TREASURY_SEED, pool.as_ref()], &pid);
    // Meteora vaults: `["token_vault", mint, pool]` under each program.
    let vault_of = |program: &Pubkey, mint: &Pubkey, pool: &Pubkey| {
        addr(&[b"token_vault", mint.as_ref(), pool.as_ref()], program)
    };
    let treasury_tokens = addr(
        &[
            partner_treasury.as_ref(),
            TOKEN_PROGRAM_ID.as_ref(),
            mint.as_ref(),
        ],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    let mut out: Vec<Ix> = Vec::new();
    ix!(
        out,
        pid,
        "sweep",
        "revenue_token_none",
        Sweep,
        Sweep {
            cranker,
            pool,
            vault,
            position,
            vote_account: vote,
            vote_auth,
            escrow,
            payout,
            advance: Some(open_advance),
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
            revenue_token: None,
            buyback_escrow: None,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "release_validator",
        "revenue_token_none",
        ReleaseValidator,
        ReleaseValidator {
            operator,
            pool,
            vault,
            position,
            vote_account: vote,
            vote_auth,
            escrow,
            new_withdrawer,
            identity,
            clock: CLOCK,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system,
            revenue_token: None,
        },
        context {}
    );
    for (label, share_bps, term_epochs) in [
        ("default", 1_000u16, 52u16),
        ("bounds", MAX_SHARE_BPS, MAX_TERM_EPOCHS),
    ] {
        ix!(
            out,
            pid,
            "register_revenue_token",
            label,
            RegisterRevenueToken {
                share_bps,
                term_epochs
            },
            RegisterRevenueToken {
                operator,
                pool,
                position,
                vote_account: vote,
                vote_auth,
                revenue_token,
                buyback_escrow,
                buyback_tokens,
                mint,
                dbc_pool,
                dbc_config,
                partner_treasury,
                token_program: TOKEN_PROGRAM_ID,
                system_program: system,
            },
            context {}
        );
    }
    ix!(
        out,
        pid,
        "sync_revenue_token_pool",
        "default",
        SyncRevenueTokenPool,
        SyncRevenueTokenPool {
            cranker,
            revenue_token,
            dbc_pool,
            damm_config,
            damm_pool,
        },
        context { vote }
    );
    for (venue, slice, min_amount_out) in [
        (BuybackVenue::Dbc, 0u8, g.u64()),
        (BuybackVenue::DammV2, 31, u64::MAX),
    ] {
        let (program, pool_authority, event_authority, venue_pool) = match venue {
            BuybackVenue::Dbc => (
                DBC_PROGRAM_ID,
                DBC_POOL_AUTHORITY,
                DBC_EVENT_AUTHORITY,
                dbc_pool,
            ),
            BuybackVenue::DammV2 => (
                CP_AMM_PROGRAM_ID,
                CP_AMM_POOL_AUTHORITY,
                CP_AMM_EVENT_AUTHORITY,
                damm_pool,
            ),
        };
        ix!(
            out,
            pid,
            "execute_buyback",
            format!("{venue:?}"),
            ExecuteBuyback {
                slice,
                min_amount_out
            },
            ExecuteBuyback {
                cranker,
                pool,
                revenue_token,
                buyback_escrow,
                buyback_wsol,
                buyback_tokens,
                mint,
                wsol_mint: NATIVE_MINT,
                dbc_config,
                venue_pool,
                venue_token_vault: vault_of(&program, &mint, &venue_pool),
                venue_quote_vault: vault_of(&program, &NATIVE_MINT, &venue_pool),
                venue_pool_authority: pool_authority,
                venue_event_authority: event_authority,
                venue_program: program,
                token_program: TOKEN_PROGRAM_ID,
                system_program: system,
            },
            context { vote, venue }
        );
    }
    for (label, with_treasury, amount) in [("curve", false, g.u64()), ("graduated", true, 1u64)] {
        ix!(
            out,
            pid,
            "redeem",
            label,
            Redeem { amount },
            Redeem {
                holder,
                holder_tokens,
                revenue_token,
                buyback_escrow,
                buyback_tokens,
                mint,
                treasury_tokens: with_treasury.then_some(treasury_tokens),
                token_program: TOKEN_PROGRAM_ID,
                system_program: system,
            },
            context { vote }
        );
    }
    for (label, params) in [
        ("default", BuybackParams::default()),
        (
            "edges",
            BuybackParams {
                slices_per_epoch: MAX_BUYBACK_SLICES,
                window_slots: u32::MAX,
                max_slippage_bps: MAX_MAX_SLIPPAGE_BPS,
                max_impact_bps: MIN_MAX_IMPACT_BPS,
                flags: FLAG_BUYBACKS_PAUSED | FLAG_REDEEM_DURING_TERM,
            },
        ),
    ] {
        ix!(
            out,
            pid,
            "configure_revenue_token",
            label,
            ConfigureRevenueToken { params },
            ConfigureRevenueToken {
                admin,
                pool,
                revenue_token
            },
            context { vote }
        );
    }
    ix!(
        out,
        pid,
        "close_revenue_token",
        "default",
        CloseRevenueToken,
        CloseRevenueToken {
            cranker,
            operator,
            pool,
            vault: addr(&[VAULT_SEED, pool.as_ref()], &pid),
            revenue_token,
            buyback_escrow,
            buyback_tokens,
            mint,
            position,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system,
        },
        context { vote }
    );
    out
}

// ─── Treasury claims ───────────────────────────────────────────────────────

fn treasury_instructions(g: &mut Gen, pid: Pubkey) -> Vec<Ix> {
    let system = anchor_lang::solana_program::system_program::ID;
    let cranker = k(6);
    let (mint, dbc_pool, dbc_config) = (g.key(), g.key(), g.key());
    let (damm_pool, position, nft_mint) = (g.key(), g.key(), g.key());

    let pool = addr(&[POOL_SEED], &pid);
    let vault = addr(&[VAULT_SEED, pool.as_ref()], &pid);
    let treasury = addr(&[PARTNER_TREASURY_SEED, pool.as_ref()], &pid);
    let treasury_wsol = addr(&[TREASURY_WSOL_SEED, pool.as_ref()], &pid);
    let treasury_tokens = addr(
        &[treasury.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    let vault_of = |program: &Pubkey, mint: &Pubkey, pool: &Pubkey| {
        addr(&[b"token_vault", mint.as_ref(), pool.as_ref()], program)
    };
    let base_vault = vault_of(&DBC_PROGRAM_ID, &mint, &dbc_pool);
    let quote_vault = vault_of(&DBC_PROGRAM_ID, &NATIVE_MINT, &dbc_pool);
    let token_a_vault = vault_of(&CP_AMM_PROGRAM_ID, &mint, &damm_pool);
    let token_b_vault = vault_of(&CP_AMM_PROGRAM_ID, &NATIVE_MINT, &damm_pool);
    let position_nft_account = addr(
        &[CP_AMM_POSITION_NFT_ACCOUNT_SEED, nft_mint.as_ref()],
        &CP_AMM_PROGRAM_ID,
    );

    let mut out: Vec<Ix> = Vec::new();
    ix!(
        out,
        pid,
        "claim_partner_trading_fee",
        "default",
        ClaimPartnerTradingFee,
        ClaimPartnerTradingFee {
            cranker,
            pool,
            vault,
            treasury,
            treasury_wsol,
            treasury_tokens,
            dbc_pool,
            dbc_config,
            base_vault,
            quote_vault,
            base_mint: mint,
            wsol_mint: NATIVE_MINT,
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "claim_partner_surplus",
        "default",
        ClaimPartnerSurplus,
        ClaimPartnerQuote {
            cranker,
            pool,
            vault,
            treasury,
            treasury_wsol,
            dbc_pool,
            dbc_config,
            quote_vault,
            wsol_mint: NATIVE_MINT,
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "claim_partner_migration_fee",
        "default",
        ClaimPartnerMigrationFee,
        ClaimPartnerQuote {
            cranker,
            pool,
            vault,
            treasury,
            treasury_wsol,
            dbc_pool,
            dbc_config,
            quote_vault,
            wsol_mint: NATIVE_MINT,
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "burn_leftover",
        "default",
        BurnLeftover,
        BurnLeftover {
            cranker,
            pool,
            treasury,
            treasury_tokens,
            dbc_pool,
            dbc_config,
            base_vault,
            base_mint: mint,
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system,
        },
        context {}
    );
    ix!(
        out,
        pid,
        "claim_treasury_lp_fee",
        "default",
        ClaimTreasuryLpFee,
        ClaimTreasuryLpFee {
            cranker,
            pool,
            vault,
            treasury,
            treasury_wsol,
            treasury_tokens,
            damm_pool,
            position,
            position_nft_account,
            token_a_vault,
            token_b_vault,
            token_a_mint: mint,
            wsol_mint: NATIVE_MINT,
            damm_pool_authority: CP_AMM_POOL_AUTHORITY,
            damm_event_authority: CP_AMM_EVENT_AUTHORITY,
            damm_program: CP_AMM_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system,
        },
        context { nft_mint }
    );
    out
}

// ─── PDAs ──────────────────────────────────────────────────────────────────

fn pdas(pid: &Pubkey) -> J {
    let mut out = Vec::new();
    let mut push = |kind: &str, inputs: Vec<(&str, J)>, seeds: &[&[u8]]| {
        let (address, bump) = pda(seeds, pid);
        out.push(obj(vec![
            ("kind", s(kind)),
            ("inputs", obj(inputs)),
            ("address", address.j()),
            ("bump", bump.j()),
        ]));
    };
    let pool = addr(&[POOL_SEED], pid);
    push("pool", vec![], &[POOL_SEED]);
    push(
        "vault",
        vec![("pool", pool.j())],
        &[VAULT_SEED, pool.as_ref()],
    );
    for (owner, tranche) in [
        (k(5), Tranche::Senior),
        (k(5), Tranche::Junior),
        (k(200), Tranche::Junior),
    ] {
        push(
            "lender",
            vec![
                ("pool", pool.j()),
                ("owner", owner.j()),
                ("tranche", tranche.j()),
            ],
            &[
                LENDER_SEED,
                pool.as_ref(),
                owner.as_ref(),
                &[tranche.as_u8()],
            ],
        );
    }
    for seq in [0u64, 1, 255, 256, (1 << 32) + 5, (1 << 53) + 1, u64::MAX] {
        push(
            "withdraw",
            vec![("pool", pool.j()), ("seq", seq.j())],
            &[WITHDRAW_SEED, pool.as_ref(), &seq.to_le_bytes()],
        );
    }
    for vote in [k(9), k(77)] {
        push(
            "position",
            vec![("vote", vote.j())],
            &[POSITION_SEED, vote.as_ref()],
        );
        push(
            "voteAuth",
            vec![("vote", vote.j())],
            &[VOTE_AUTH_SEED, vote.as_ref()],
        );
        push(
            "escrow",
            vec![("vote", vote.j())],
            &[ESCROW_SEED, vote.as_ref()],
        );
        for seq in [0u64, 9, u64::MAX] {
            push(
                "advance",
                vec![("vote", vote.j()), ("seq", seq.j())],
                &[ADVANCE_SEED, vote.as_ref(), &seq.to_le_bytes()],
            );
        }
    }
    push(
        "feeIndex",
        vec![("pool", pool.j())],
        &[FEE_INDEX_SEED, pool.as_ref()],
    );
    for (maker, epoch) in [(k(15), 0u64), (k(15), 813), (k(99), u64::MAX)] {
        push(
            "quote",
            vec![("maker", maker.j()), ("epoch", epoch.j())],
            &[QUOTE_SEED, maker.as_ref(), &epoch.to_le_bytes()],
        );
    }
    for (quote, taker) in [(k(19), k(16)), (k(21), k(22))] {
        push(
            "swap",
            vec![("quote", quote.j()), ("taker", taker.j())],
            &[SWAP_SEED, quote.as_ref(), taker.as_ref()],
        );
    }
    for vote in [k(9), k(77)] {
        for (kind, seed) in [
            ("revenueToken", REVENUE_TOKEN_SEED),
            ("buyback", BUYBACK_SEED),
            ("buybackWsol", BUYBACK_WSOL_SEED),
            ("buybackTokens", BUYBACK_TOKENS_SEED),
        ] {
            push(kind, vec![("vote", vote.j())], &[seed, vote.as_ref()]);
        }
    }
    push(
        "partnerTreasury",
        vec![("pool", pool.j())],
        &[PARTNER_TREASURY_SEED, pool.as_ref()],
    );
    push(
        "treasuryWsol",
        vec![("pool", pool.j())],
        &[TREASURY_WSOL_SEED, pool.as_ref()],
    );
    for vote in [k(9), k(77)] {
        push(
            "history",
            vec![("vote", vote.j())],
            &[HISTORY_SEED, vote.as_ref()],
        );
    }
    push(
        "scoreConfig",
        vec![("pool", pool.j())],
        &[SCORE_CONFIG_SEED, pool.as_ref()],
    );
    J::Arr(out)
}

// ─── Errors ────────────────────────────────────────────────────────────────

macro_rules! error_table {
    ($($v:ident),* $(,)?) => {{
        // Exhaustive: a variant added to EpochError and missing here fails the build.
        fn _exhaustive(e: EpochError) {
            match e {
                $(EpochError::$v => {}),*
            }
        }
        vec![$({
            let e = EpochError::$v;
            obj(vec![("name", s(e.name())), ("code", J::Int(i64::from(u32::from(e)))), ("message", s(e.to_string()))])
        }),*]
    }};
}

fn errors() -> J {
    J::Arr(error_table!(
        Paused,
        NotAdmin,
        NotScorer,
        NotPublisher,
        BpsOutOfRange,
        InvalidParams,
        MathOverflow,
        ZeroAmount,
        PoolCapExceeded,
        InsufficientShares,
        InsufficientLiquidity,
        JuniorLocked,
        JuniorFloorBreached,
        NotHeadOfQueue,
        RequestCancelled,
        AlreadyAccrued,
        VaultLedgerMismatch,
        NotAVoteAccount,
        UnsupportedVoteState,
        NotWithdrawAuthority,
        ProgramNotWithdrawAuthority,
        IdentityMismatch,
        NotOperator,
        PayoutMismatch,
        PositionNotActive,
        AdvanceAlreadyOpen,
        AdvanceMismatch,
        AdvanceOpen,
        NoOpenAdvance,
        AdvanceStateInvalid,
        ScoreTooLow,
        ScoreStale,
        OverLimit,
        BelowMinimum,
        UtilizationCapExceeded,
        InsufficientHistory,
        AlreadySweptThisEpoch,
        RewardsInProgress,
        NotDefaultable,
        CommissionTooLow,
        CommissionChangeBlocked,
        BondLocked,
        IndexEpochNotNewer,
        IndexMoveTooLarge,
        NoProposal,
        DisputeWindowOpen,
        DisputeWindowClosed,
        IndexMissing,
        QuoteExpired,
        QuoteEpochMismatch,
        QuoteCapacityExceeded,
        QuoteHasOpenSwaps,
        AlreadySettled,
        NotMaker,
        RevenueTokenExists,
        ShareOutOfRange,
        TermOutOfRange,
        InvalidRevenueMint,
        InvalidDbcPool,
        InvalidDbcConfig,
        RevenueTokenMismatch,
        RevenueTokenAccountsMissing,
        RevenueTokenTermActive,
        CommissionBelowSnapshot,
        PoolNotMigrated,
        InvalidDammPool,
        PoolNotSynced,
        VenueNotTrading,
        InvalidVenueAccount,
        OutsideBuybackWindow,
        SliceNotDue,
        SliceAlreadyExecuted,
        InvalidSlice,
        SweepPending,
        NothingToBuy,
        MinOutTooLow,
        BuybackOutputTooLow,
        BuybacksPaused,
        RedeemNotAllowed,
        RedeemTooLarge,
        EscrowNotEmpty,
        InvalidBuybackParams,
        NotTreasuryFeeClaimer,
        NotTreasuryLeftoverReceiver,
        NotTreasuryPosition,
        NothingToClaim,
        ClaimNotReady,
        AlreadyClaimed,
        UnsupportedClaimPool,
        InvalidClaimAccount,
        LiquidityNotLocked,
        UnsupportedVenueFee,
        ImpactAboveFeeBound,
        HistoryEpochOutOfRange,
        HistoryVoteMismatch,
        HistoryStale,
        StakeInfoStale,
        InvalidDistributionAccount,
        InvalidHedgeAccount,
        HistoryIsFresh,
        InvalidScoreConfig,
    ))
}

// ─── Math ──────────────────────────────────────────────────────────────────

fn case(args: Vec<J>, result: J) -> J {
    obj(vec![("args", J::Arr(args)), ("result", result)])
}

/// Edge values: zero, one, bps scale, 2^53 (JavaScript's exact-integer limit), 2^63, u64::MAX.
const EDGES: [u64; 8] = [
    0,
    1,
    1_000,
    10_000,
    1 << 53,
    (1 << 53) + 1,
    1 << 63,
    u64::MAX,
];

fn bps_samples() -> Vec<u16> {
    vec![0, 1, 2_500, 3_333, 9_999, 10_000, 10_001, u16::MAX]
}

#[allow(clippy::too_many_lines)]
fn math(g: &mut Gen, g2: &mut Gen, g3: &mut Gen) -> J {
    let mut out: Vec<(&str, J)> = Vec::new();

    // bps_of / bps_of_ceil: every edge amount × every edge bps, plus random pairs.
    let mut bps_of = Vec::new();
    let mut bps_of_ceil = Vec::new();
    let mut pairs: Vec<(u64, u16)> = Vec::new();
    for a in EDGES {
        for b in bps_samples() {
            pairs.push((a, b));
        }
    }
    for _ in 0..24 {
        pairs.push((g.sized(), g.u16() % 12_000));
    }
    for (a, b) in pairs {
        bps_of.push(case(vec![a.j(), b.j()], math::bps_of(a, b).j()));
        bps_of_ceil.push(case(vec![a.j(), b.j()], math::bps_of_ceil(a, b).j()));
    }
    out.push(("bps_of", J::Arr(bps_of)));
    out.push(("bps_of_ceil", J::Arr(bps_of_ceil)));

    // mul_div
    let mut mul_div = Vec::new();
    let mut triples: Vec<(u64, u64, u64)> = Vec::new();
    for a in [0u64, 1, 10, 1 << 53, u64::MAX] {
        for b in [0u64, 2, 3, 1 << 63, u64::MAX] {
            for c in [0u64, 1, 2, 4, u64::MAX] {
                triples.push((a, b, c));
            }
        }
    }
    for _ in 0..30 {
        triples.push((g.sized(), g.sized(), g.sized().max(1)));
    }
    for (a, b, c) in triples {
        mul_div.push(case(vec![a.j(), b.j(), c.j()], math::mul_div(a, b, c).j()));
    }
    out.push(("mul_div", J::Arr(mul_div)));

    // Share math, with the virtual offsets: edges for all three inputs, plus random triples.
    let mut a2s = Vec::new();
    let mut s2a = Vec::new();
    let mut triples: Vec<(u64, u64, u64)> = Vec::new();
    for a in [0u64, 1, 1_000_000_000, (1 << 53) + 1, u64::MAX] {
        for ta in [0u64, 1, 999, 1_000_000_000, u64::MAX] {
            for ts in [0u64, 1, 1_000, 1_000_000_000_000, u64::MAX] {
                triples.push((a, ta, ts));
            }
        }
    }
    for _ in 0..40 {
        triples.push((g.sized(), g.sized(), g.sized()));
    }
    for (a, ta, ts) in &triples {
        a2s.push(case(
            vec![a.j(), ta.j(), ts.j()],
            math::assets_to_shares(*a, *ta, *ts).j(),
        ));
        s2a.push(case(
            vec![a.j(), ta.j(), ts.j()],
            math::shares_to_assets(*a, *ta, *ts).j(),
        ));
    }
    out.push(("assets_to_shares", J::Arr(a2s)));
    out.push(("shares_to_assets", J::Arr(s2a)));
    let mut price = Vec::new();
    let mut pairs: Vec<(u64, u64)> = Vec::new();
    for ta in EDGES {
        for ts in EDGES {
            pairs.push((ta, ts));
        }
    }
    for _ in 0..20 {
        pairs.push((g.sized(), g.sized()));
    }
    for (ta, ts) in pairs {
        price.push(case(vec![ta.j(), ts.j()], math::share_price_e9(ta, ts).j()));
    }
    out.push(("share_price_e9", J::Arr(price)));

    // credit_limit; args = [trailing_revenue, history_epochs, advance_bps, bond_lamports, bond_multiplier, cap_lamports]
    let mut credit = Vec::new();
    let mut credit_inputs = vec![
        (
            100_000_000_000u64,
            10u8,
            2_500u16,
            0u64,
            0u8,
            50_000_000_000u64,
        ),
        (100_000_000_000, 10, 4_000, 0, 0, 50_000_000_000),
        (100_000_000_000, 10, 2_500, 0, 0, 10_000_000_000),
        (100_000_000_000, 10, 2_500, 3_000_000_000, 2, 50_000_000_000),
        (100_000_000_000, 2, 2_500, 0, 0, 50_000_000_000),
        (100_000_000_000, 3, 2_500, 0, 0, u64::MAX),
        (100_000_000_000, 10, 2_500, u64::MAX, 255, 50_000_000_000),
        (u64::MAX, 255, u16::MAX, 0, 0, u64::MAX),
        (u64::MAX, 0, u16::MAX, u64::MAX, 255, u64::MAX),
    ];
    for _ in 0..40 {
        let multiplier = if g.u8() % 3 == 0 { 0 } else { g.u8() };
        credit_inputs.push((
            g.sized(),
            g.u8() % 12,
            g.u16() % 11_000,
            g.sized(),
            multiplier,
            g.sized(),
        ));
    }
    for (
        trailing_revenue,
        history_epochs,
        advance_bps,
        bond_lamports,
        bond_multiplier,
        cap_lamports,
    ) in credit_inputs
    {
        let i = CreditInputs {
            trailing_revenue,
            history_epochs,
            advance_bps,
            bond_lamports,
            bond_multiplier,
            cap_lamports,
        };
        credit.push(case(
            vec![
                trailing_revenue.j(),
                history_epochs.j(),
                advance_bps.j(),
                bond_lamports.j(),
                bond_multiplier.j(),
                cap_lamports.j(),
            ],
            math::credit_limit(&i).j(),
        ));
    }
    out.push(("credit_limit", J::Arr(credit)));

    // split_sweep
    let mut split = Vec::new();
    let mut split_cases: Vec<(u64, u64, u16, bool)> = vec![
        (1_000, 10_000, 2_500, false),
        (1_000, 100, 2_500, false),
        (1_000, 5_000, 2_500, true),
        (0, 5_000, 2_500, true),
        (1_000, 0, 2_500, false),
        (u64::MAX, u64::MAX, u16::MAX, false),
        (u64::MAX, u64::MAX, 10_000, false),
        (u64::MAX, 1, 0, true),
    ];
    for _ in 0..30 {
        split_cases.push((g.sized(), g.sized(), g.u16() % 12_000, g.u8() % 4 == 0));
    }
    for (gross, outstanding, remit_bps, full) in split_cases {
        let r = math::split_sweep(gross, outstanding, remit_bps, full).map(|x| {
            obj(vec![
                ("remit", x.remit.j()),
                ("to_operator", x.to_operator.j()),
            ])
        });
        split.push(case(
            vec![gross.j(), outstanding.j(), remit_bps.j(), full.j()],
            r.unwrap_or(J::Null),
        ));
    }
    out.push(("split_sweep", J::Arr(split)));

    // attribute_repayment; result = [principal, fee]
    let mut attr = Vec::new();
    let mut attr_cases: Vec<(u64, u64, u64)> = vec![
        (510, 1_000, 20),
        (1_020, 1_000, 20),
        (5_000, 1_000, 20),
        (5, 0, 0),
        (0, 1_000, 20),
        (1_019, 1_000, 20),
        (7, 3, 4),
        (u64::MAX, u64::MAX, 1),
        (u64::MAX, u64::MAX - 1, 1),
        (123, 0, 50),
    ];
    for r in [1u64, 3, 7, 99, 101, 999] {
        attr_cases.push((r, 1_000, 20));
    }
    for _ in 0..30 {
        attr_cases.push((g.sized(), g.sized(), g.sized()));
    }
    for (remit, p, f) in attr_cases {
        let r = math::attribute_repayment(remit, p, f).map(|(pp, fp)| J::Arr(vec![pp.j(), fp.j()]));
        attr.push(case(vec![remit.j(), p.j(), f.j()], r.unwrap_or(J::Null)));
    }
    out.push(("attribute_repayment", J::Arr(attr)));

    // distribute_income
    let mut dist = Vec::new();
    let mut dist_cases: Vec<(u64, u64, u16, u64, u16)> = vec![
        (10_000, 1_000_000, 4, 1, 1_000),
        (300, 1_000_000, 4, 1, 0),
        (10_000, 1_000_000, 4, 3, 0),
        (0, 5, 5, 5, 5),
        (1_000, 0, 4, 1, 10_001),
        (u64::MAX, u64::MAX, 10_000, 2, 0),
        (u64::MAX, u64::MAX, u16::MAX, 1, 0),
        (u64::MAX, 1_000_000, 4, u64::MAX, 10_000),
    ];
    for _ in 0..30 {
        dist_cases.push((
            g.sized(),
            g.sized(),
            g.u16() % 200,
            g.u64() % 40,
            g.u16() % 10_500,
        ));
    }
    for (income, senior, rate, epochs, fee) in dist_cases {
        let r = math::distribute_income(income, senior, rate, epochs, fee).map(|d| {
            obj(vec![
                ("protocol_fee", d.protocol_fee.j()),
                ("senior_gain", d.senior_gain.j()),
                ("junior_gain", d.junior_gain.j()),
            ])
        });
        dist.push(case(
            vec![income.j(), senior.j(), rate.j(), epochs.j(), fee.j()],
            r.unwrap_or(J::Null),
        ));
    }
    out.push(("distribute_income", J::Arr(dist)));

    // absorb_loss; result = [senior_assets, junior_assets, unabsorbed]
    let mut absorb = Vec::new();
    let mut absorb_cases: Vec<(u64, u64, u64)> = vec![
        (100, 1_000, 500),
        (600, 1_000, 500),
        (2_000, 1_000, 500),
        (0, 0, 0),
        (u64::MAX, u64::MAX, u64::MAX),
        (u64::MAX, 0, 0),
    ];
    for _ in 0..20 {
        absorb_cases.push((g.sized(), g.sized(), g.sized()));
    }
    for (loss, senior, junior) in absorb_cases {
        let (s2, j2, u) = math::absorb_loss(loss, senior, junior);
        absorb.push(case(
            vec![loss.j(), senior.j(), junior.j()],
            J::Arr(vec![s2.j(), j2.j(), u.j()]),
        ));
    }
    out.push(("absorb_loss", J::Arr(absorb)));

    // junior_ratio_bps
    let mut ratio = Vec::new();
    let mut ratio_cases: Vec<(u64, u64)> = vec![
        (900, 100),
        (0, 0),
        (0, 5),
        (5, 0),
        (950_000, 50_000),
        (u64::MAX, 1),
        (u64::MAX, 0),
        (u64::MAX / 2, u64::MAX / 2),
    ];
    for _ in 0..20 {
        ratio_cases.push((g.sized(), g.sized()));
    }
    for (senior, junior) in ratio_cases {
        ratio.push(case(
            vec![senior.j(), junior.j()],
            math::junior_ratio_bps(senior, junior).j(),
        ));
    }
    out.push(("junior_ratio_bps", J::Arr(ratio)));

    // taker_pnl; args = [side, notional, fixed_rate, index_value, max_loss]
    let mut pnl = Vec::new();
    let mut pnl_cases: Vec<(Side, u64, u64, u64, u64)> = vec![
        (Side::PayFixed, 1_000_000_000, 10_000, 11_000, 500_000_000),
        (
            Side::ReceiveFixed,
            1_000_000_000,
            10_000,
            11_000,
            500_000_000,
        ),
        (Side::PayFixed, 1_000_000_000, 10_000, 30_000, 200_000_000),
        (Side::PayFixed, 1_000_000_000, 10_000, 1, 200_000_000),
        (
            Side::ReceiveFixed,
            1_000_000_000,
            10_000,
            30_000,
            200_000_000,
        ),
        (Side::PayFixed, 5, 10_000, 10_000, 1),
        (Side::PayFixed, 5, 0, 10_000, 1),
        // Rounding toward zero: 7 × (1 − 3) / 3 = −4.67 → −4 (floor would give −5).
        (Side::PayFixed, 7, 3, 1, 100),
        (Side::ReceiveFixed, 7, 3, 1, 100),
        (Side::PayFixed, 7, 3, 5, 100),
        (Side::ReceiveFixed, 7, 3, 5, 100),
        // i128 multiplication overflow → None.
        (Side::PayFixed, u64::MAX, 1, u64::MAX, u64::MAX),
        (Side::ReceiveFixed, u64::MAX, u64::MAX, 0, u64::MAX),
        // Clamp to ±cap where the cap exceeds i64 → i64::try_from fails → None.
        (Side::PayFixed, u64::MAX, 1, 3, u64::MAX),
        (Side::ReceiveFixed, u64::MAX, 1, 3, u64::MAX),
        // Clamp inside i64.
        (Side::PayFixed, u64::MAX, 1, 3, i64::MAX as u64),
        (Side::ReceiveFixed, u64::MAX, 1, 3, i64::MAX as u64),
        (Side::ReceiveFixed, u64::MAX, 1, 3, (i64::MAX as u64) + 1),
        (Side::PayFixed, 0, 1, u64::MAX, 0),
    ];
    for _ in 0..40 {
        let side = if g.u8() % 2 == 0 {
            Side::PayFixed
        } else {
            Side::ReceiveFixed
        };
        let fixed = g.sized() % 100_000 + u64::from(g.u8() % 2);
        pnl_cases.push((side, g.sized(), fixed, g.sized() % 200_000, g.sized()));
    }
    for (side, notional, fixed, index, max_loss) in pnl_cases {
        pnl.push(case(
            vec![side.j(), notional.j(), fixed.j(), index.j(), max_loss.j()],
            taker_pnl(side, notional, fixed, index, max_loss).j(),
        ));
    }
    out.push(("taker_pnl", J::Arr(pnl)));

    // compute_score; args = [credits_ratio_bps, commission_bps, epochs_active, delinquent, superminority].
    // Every credits boundary × every commission boundary, at four tenures, plus the flags.
    let mut score = Vec::new();
    let credits = [
        0u16,
        1,
        4_500,
        8_999,
        9_000,
        9_001,
        9_350,
        9_699,
        9_700,
        9_701,
        10_000,
        u16::MAX,
    ];
    let commissions = [0u16, 499, 500, 501, 750, 999, 1_000, 1_001, u16::MAX];
    let mut inputs: Vec<(u16, u16, u16, bool, bool)> = Vec::new();
    for c in credits {
        for m in commissions {
            for t in [0u16, 15, 30, u16::MAX] {
                inputs.push((c, m, t, false, false));
            }
            inputs.push((c, m, 30, false, true));
        }
        inputs.push((c, 500, 30, true, false));
        inputs.push((c, 500, 30, true, true));
    }
    for t in [1u16, 29, 31, 60] {
        inputs.push((9_900, 500, t, false, false));
    }
    for (c, m, t, delinquent, superminority) in inputs {
        let i = ScoreInputs {
            credits_ratio_bps: c,
            commission_bps: m,
            epochs_active: t,
            delinquent,
            superminority,
        };
        score.push(case(
            vec![c.j(), m.j(), t.j(), delinquent.j(), superminority.j()],
            math::compute_score(&i).j(),
        ));
    }
    out.push(("compute_score", J::Arr(score)));

    out.extend(revenue_math(g2));
    out.extend(treasury_math(g3));
    obj(out)
}

fn treasury_math(g: &mut Gen) -> Vec<(&'static str, J)> {
    let mut out: Vec<(&'static str, J)> = Vec::new();
    let pcts = [0u8, 1, 20, 50, 70, 99, 100, 101, u8::MAX];

    // dbc_partner_part; args = [fee, creator_trading_fee_percentage]
    let mut part = Vec::new();
    for fee in [0u64, 1, 99, 100, 1_001, 1 << 53, u64::MAX, g.sized()] {
        for pct in pcts {
            part.push(case(
                vec![fee.j(), pct.j()],
                math::dbc_partner_part(fee, pct).j(),
            ));
        }
    }
    out.push(("dbc_partner_part", J::Arr(part)));

    // dbc_partner_surplus; args = [quote_reserve, threshold, creator_trading_fee_percentage]
    let mut surplus = Vec::new();
    for (reserve, threshold) in [
        (999u64, 1_000u64),
        (1_000, 1_000),
        (2_001, 1_000),
        (10_100_000_000, 10_000_000_000),
        (u64::MAX, 0),
        (u64::MAX, u64::MAX - 1),
        (g.sized(), g.sized()),
    ] {
        for pct in [0u8, 30, 50, 100, 101] {
            surplus.push(case(
                vec![reserve.j(), threshold.j(), pct.j()],
                math::dbc_partner_surplus(reserve, threshold, pct).j(),
            ));
        }
    }
    out.push(("dbc_partner_surplus", J::Arr(surplus)));

    // dbc_partner_migration_fee; args = [threshold, migration_fee_percentage, creator_migration_fee_percentage]
    let mut migration = Vec::new();
    for threshold in [0u64, 999, 1_000, 10_000_000_000, u64::MAX, g.sized()] {
        for (fee_pct, creator_pct) in [
            (0u8, 0u8),
            (7, 70),
            (10, 50),
            (50, 0),
            (100, 100),
            (101, 0),
            (u8::MAX, 1),
        ] {
            migration.push(case(
                vec![threshold.j(), fee_pct.j(), creator_pct.j()],
                math::dbc_partner_migration_fee(threshold, fee_pct, creator_pct).j(),
            ));
        }
    }
    out.push(("dbc_partner_migration_fee", J::Arr(migration)));

    // dbc_leftover; args = [base_vault, partner_base_fee, protocol_base_fee, creator_base_fee, protocol_migration_base_fee]
    let mut leftover = Vec::new();
    let mut rows: Vec<[u64; 5]> = vec![
        [1_000, 10, 20, 30, 40],
        [100, 10, 20, 30, 40],
        [99, 10, 20, 30, 40],
        [u64::MAX, u64::MAX, 1, 0, 0],
        [u64::MAX, 0, 0, 0, u64::MAX],
        [0, 0, 0, 0, 0],
        [500_000_000_000_000, 31_637_637_373, 0, 0, 43_800_000_455],
    ];
    for _ in 0..8 {
        let vault = g.sized();
        rows.push([vault, vault / 7, vault / 11, vault / 13, vault / 5]);
    }
    for r in rows {
        leftover.push(case(
            r.iter().map(ToJ::j).collect(),
            math::dbc_leftover(r[0], r[1], r[2], r[3], r[4]).j(),
        ));
    }
    out.push(("dbc_leftover", J::Arr(leftover)));
    out
}

fn fill_json(f: math::BuyFill) -> J {
    obj(vec![
        ("output", f.output.j()),
        ("consumed", f.consumed.j()),
        ("next_sqrt_price", f.next_sqrt_price.j()),
    ])
}

fn curve_json(curve: &[CurvePoint]) -> J {
    J::Arr(
        curve
            .iter()
            .map(|p| {
                obj(vec![
                    ("sqrt_price", p.sqrt_price.j()),
                    ("liquidity", p.liquidity.j()),
                ])
            })
            .collect(),
    )
}

/// Q64.64 √P of a price in lamports per raw token unit, as DBC configs hold it.
fn sqrt_q64(price: f64) -> u128 {
    (price.sqrt() * 18_446_744_073_709_551_616.0) as u128
}

/// Revenue-token and Meteora math (`math::revenue_token`, `math::amm`).
#[allow(clippy::too_many_lines)]
fn revenue_math(g: &mut Gen) -> Vec<(&'static str, J)> {
    let mut out: Vec<(&'static str, J)> = Vec::new();

    // split_sweep_with_share; args = [gross, share_bps, outstanding, remit_bps, full_remit, senior_advance]
    let mut cases: Vec<(u64, u16, u64, u16, bool, bool)> = vec![
        (10_000, 1_000, 1_000_000, 5_000, false, false),
        (10_000, 1_000, 0, 0, false, false),
        (10_000, 2_500, 1_000_000, 5_000, true, false),
        (10_000, 0, 1_000_000, 5_000, false, false),
        (10_000, 1_000, 1_000_000, 5_000, false, true),
        (10_000, 1_000, 1_000_000, 5_000, true, true),
        (10_000, 5_000, 1_000_000, 8_000, false, true),
        (u64::MAX, 5_000, u64::MAX, 10_000, false, false),
        (u64::MAX, u16::MAX, 0, 0, false, false),
        (u64::MAX, 10_001, 5, 0, false, false),
        (0, 5_000, 0, 0, true, true),
    ];
    for _ in 0..40 {
        cases.push((
            g.sized(),
            g.u16() % 5_200,
            g.sized(),
            g.u16() % 10_500,
            g.u8() % 4 == 0,
            g.u8() % 2 == 0,
        ));
    }
    out.push((
        "split_sweep_with_share",
        J::Arr(
            cases
                .into_iter()
                .map(|(gross, share, outstanding, remit, full, senior)| {
                    let r = math::split_sweep_with_share(
                        gross,
                        share,
                        outstanding,
                        remit,
                        full,
                        senior,
                    )
                    .map(|x| {
                        obj(vec![
                            ("share", x.share.j()),
                            ("remit", x.remit.j()),
                            ("to_operator", x.to_operator.j()),
                        ])
                    });
                    case(
                        vec![
                            gross.j(),
                            share.j(),
                            outstanding.j(),
                            remit.j(),
                            full.j(),
                            senior.j(),
                        ],
                        r.unwrap_or(J::Null),
                    )
                })
                .collect(),
        ),
    ));

    // slice_due_slot and slice_timing; args = [slice, slices, window_slots] / [slot_index, ...]
    let mut due = Vec::new();
    let mut timing = Vec::new();
    let windows = [0u32, 1, 4, 9_000, 431_999, u32::MAX];
    for slices in [0u8, 1, 4, 12, 32, u8::MAX] {
        for window in windows {
            for slice in [0u8, 1, slices.saturating_sub(1), slices, u8::MAX] {
                due.push(case(
                    vec![slice.j(), slices.j(), window.j()],
                    math::slice_due_slot(slice, slices, window).j(),
                ));
                let start = math::slice_due_slot(slice, slices, window).unwrap_or(0);
                for slot in [
                    0u64,
                    start.saturating_sub(1),
                    start,
                    u64::from(window),
                    u64::MAX,
                ] {
                    let t = math::slice_timing(slot, slice, slices, window).map(|t| match t {
                        SliceTiming::Due => s("Due"),
                        SliceTiming::NotDue => s("NotDue"),
                        SliceTiming::WindowClosed => s("WindowClosed"),
                    });
                    timing.push(case(
                        vec![slot.j(), slice.j(), slices.j(), window.j()],
                        t.unwrap_or(J::Null),
                    ));
                }
            }
        }
    }
    out.push(("slice_due_slot", J::Arr(due)));
    out.push(("slice_timing", J::Arr(timing)));

    // slice_budget; args = [epoch_budget, epoch_spent, slices, slices_done, escrow_available]
    let mut budget_cases: Vec<(u64, u64, u8, u32, u64)> = vec![
        (12_000, 0, 12, 0, 12_000),
        (12_000, 5_000, 12, 0b11111, 7_000),
        (12_000, 4_000, 12, 0b11111, 8_000),
        (12_000, 11_500, 12, (1 << 11) - 1, 500),
        (12_000, 0, 12, 0, 600),
        (12_000, 0, 12, (1 << 12) - 1, 12_000),
        (100, 150, 4, 1, 500),
        (u64::MAX, 0, 1, 0, u64::MAX),
        (u64::MAX, 1, 32, u32::MAX >> 1, u64::MAX),
        (5, 0, 2, u32::MAX, 5),
        (5, 0, 0, 0, 5),
    ];
    for _ in 0..30 {
        let slices = g.u8() % 33;
        budget_cases.push((
            g.sized(),
            g.sized(),
            slices,
            g.u32() >> (g.u8() % 32),
            g.sized(),
        ));
    }
    out.push((
        "slice_budget",
        J::Arr(
            budget_cases
                .into_iter()
                .map(|(b, spent, slices, done, escrow)| {
                    case(
                        vec![b.j(), spent.j(), slices.j(), done.j(), escrow.j()],
                        math::slice_budget(b, spent, slices, done, escrow).j(),
                    )
                })
                .collect(),
        ),
    ));

    // redeem_payout; args = [escrow_available, amount, circulating]
    let mut redeem_cases: Vec<(u64, u64, u64)> = vec![
        (1_000, 250, 1_000),
        (1_000, 1, 3),
        (1_000, 1_001, 1_000),
        (0, 5, 10),
        (1, 0, 0),
        (u64::MAX, u64::MAX, u64::MAX),
        (u64::MAX, 1, u64::MAX),
    ];
    for _ in 0..20 {
        let circulating = g.sized();
        redeem_cases.push((g.sized(), circulating >> (g.u8() % 8), circulating));
    }
    out.push((
        "redeem_payout",
        J::Arr(
            redeem_cases
                .into_iter()
                .map(|(e, a, c)| case(vec![e.j(), a.j(), c.j()], math::redeem_payout(e, a, c).j()))
                .collect(),
        ),
    ));

    // The Meteora curve math, at realistic Q64.64 prices (1e-9 to 1e-3 lamports per raw unit)
    // and at the u128 edges.
    let q64: u128 = 1 << 64;
    let prices: Vec<u128> = vec![
        sqrt_q64(1e-9),
        sqrt_q64(2.5e-8),
        sqrt_q64(1e-6),
        sqrt_q64(1e-3),
        q64,
        2 * q64,
        u128::MAX >> 1,
        u128::MAX,
        0,
        1,
    ];
    let liquidities: Vec<u128> = vec![0, 1, 1_000_000_000u128 << 65, 1 << 100, u128::MAX];
    let mut delta_base = Vec::new();
    let mut delta_quote = Vec::new();
    let mut next_sqrt = Vec::new();
    for (i, lower) in prices.iter().enumerate() {
        for upper in prices.iter().skip(i.saturating_sub(1)).take(3) {
            for l in &liquidities {
                for round_up in [false, true] {
                    delta_base.push(case(
                        vec![lower.j(), upper.j(), l.j(), round_up.j()],
                        math::delta_base(*lower, *upper, *l, round_up).j(),
                    ));
                    delta_quote.push(case(
                        vec![lower.j(), upper.j(), l.j(), round_up.j()],
                        math::delta_quote(*lower, *upper, *l, round_up).j(),
                    ));
                }
            }
        }
        for l in &liquidities {
            for amount in [0u64, 1, 1_000_000_000, u64::MAX] {
                next_sqrt.push(case(
                    vec![lower.j(), l.j(), amount.j()],
                    math::next_sqrt_from_quote_in(*lower, *l, amount).j(),
                ));
            }
        }
    }
    for _ in 0..20 {
        let a = u128::from(g.u64()) << (g.u8() % 64);
        let b = a.saturating_add(u128::from(g.sized()) << (g.u8() % 40));
        let l = u128::from(g.u64()) << (g.u8() % 64);
        delta_base.push(case(
            vec![a.j(), b.j(), l.j(), false.j()],
            math::delta_base(a, b, l, false).j(),
        ));
        delta_quote.push(case(
            vec![a.j(), b.j(), l.j(), true.j()],
            math::delta_quote(a, b, l, true).j(),
        ));
        let amount = g.sized();
        next_sqrt.push(case(
            vec![a.j(), l.j(), amount.j()],
            math::next_sqrt_from_quote_in(a, l, amount).j(),
        ));
    }
    out.push(("delta_base", J::Arr(delta_base)));
    out.push(("delta_quote", J::Arr(delta_quote)));
    out.push(("next_sqrt_from_quote_in", J::Arr(next_sqrt)));

    // DBC curves: a two-segment toy curve and a revenue-anchored 3-point curve (start 2.5e-8,
    // migration 1e-7 SOL per raw unit; liquidity sized for ~10 SOL per segment).
    let toy = vec![
        CurvePoint {
            sqrt_price: 2 * q64,
            liquidity: 1_000_000_000u128 << 65,
        },
        CurvePoint {
            sqrt_price: 4 * q64,
            liquidity: 2_000_000_000u128 << 65,
        },
        CurvePoint::default(),
    ];
    let (s0, s1, s2, s3) = (
        sqrt_q64(2.5e-8),
        sqrt_q64(5e-8),
        sqrt_q64(7.5e-8),
        sqrt_q64(1e-7),
    );
    let seg = |from: u128, to: u128, quote: u64| -> u128 {
        // L = Δquote × 2^128 / Δ√P
        let (q, _) = U256::shl128(u128::from(quote))
            .div_rem(U256::from_u128(to - from))
            .expect("nonzero");
        q.to_u128().expect("fits")
    };
    let real = vec![
        CurvePoint {
            sqrt_price: s1,
            liquidity: seg(s0, s1, 3_000_000_000),
        },
        CurvePoint {
            sqrt_price: s2,
            liquidity: seg(s1, s2, 3_500_000_000),
        },
        CurvePoint {
            sqrt_price: s3,
            liquidity: seg(s2, s3, 4_000_000_000),
        },
    ];
    let mut dbc_buy = Vec::new();
    let mut dbc_max = Vec::new();
    for (curve, start, stop) in [
        (&toy, q64, 4 * q64),
        (&toy, q64, 3 * q64),
        (&toy, 3 * q64, 3 * q64),
        (&real, s0, s3),
        (&real, s1 + 12_345, s3),
        (&real, s2, s2 + (s3 - s2) / 2),
    ] {
        for amount in [
            0u64,
            1,
            9_999_999,
            1_000_000_000,
            6_000_000_000,
            50_000_000_000,
            u64::MAX,
        ] {
            dbc_buy.push(case(
                vec![curve_json(curve), start.j(), stop.j(), amount.j()],
                math::dbc_buy(curve, start, stop, amount)
                    .map(fill_json)
                    .unwrap_or(J::Null),
            ));
        }
        for bps in [0u16, 10, 100, 1_000, u16::MAX] {
            let target = math::impact_target_sqrt_price(start, bps).unwrap_or(u128::MAX);
            dbc_max.push(case(
                vec![curve_json(curve), start.j(), stop.j(), target.j()],
                math::dbc_max_quote_in(curve, start, stop, target).j(),
            ));
        }
    }
    out.push(("dbc_buy", J::Arr(dbc_buy)));
    out.push(("dbc_max_quote_in", J::Arr(dbc_max)));

    // DAMM v2: concentrated (√P, L, √P_max) and compounding (reserves).
    let mut conc_buy = Vec::new();
    let mut conc_max = Vec::new();
    for (sqrt, l, max) in [
        (q64, 1_000_000_000u128 << 65, u128::MAX),
        (q64, 1_000_000_000u128 << 65, q64 + 1),
        (s3, 1u128 << 90, sqrt_q64(1e-3)),
        (sqrt_q64(1e-6), 1u128 << 70, u128::MAX),
        (q64, 0, u128::MAX),
    ] {
        for amount in [0u64, 1, 2_000_000_000, 1 << 40, u64::MAX] {
            conc_buy.push(case(
                vec![sqrt.j(), l.j(), max.j(), amount.j()],
                math::damm_concentrated_buy(sqrt, l, max, amount)
                    .map(fill_json)
                    .unwrap_or(J::Null),
            ));
        }
        for bps in [0u16, 10, 100, 1_000] {
            let target = math::impact_target_sqrt_price(sqrt, bps).unwrap_or(u128::MAX);
            conc_max.push(case(
                vec![sqrt.j(), l.j(), max.j(), target.j()],
                math::damm_concentrated_max_quote_in(sqrt, l, max, target).j(),
            ));
        }
    }
    out.push(("damm_concentrated_buy", J::Arr(conc_buy)));
    out.push(("damm_concentrated_max_quote_in", J::Arr(conc_max)));
    let mut comp_buy = Vec::new();
    let mut comp_max = Vec::new();
    for (a, b) in [
        (1_000u64, 1_000u64),
        (0, 0),
        (u64::MAX, u64::MAX),
        (500_000_000_000_000, 80_000_000_000),
        (g.sized(), g.sized()),
    ] {
        for amount in [0u64, 1, 1_000, 2_000_000_000, u64::MAX] {
            comp_buy.push(case(
                vec![a.j(), b.j(), amount.j()],
                math::damm_compounding_buy(a, b, amount)
                    .map(fill_json)
                    .unwrap_or(J::Null),
            ));
        }
        for bps in [0u16, 10, 100, 1_000, u16::MAX] {
            comp_max.push(case(
                vec![b.j(), bps.j()],
                math::damm_compounding_max_quote_in(b, bps).j(),
            ));
        }
    }
    out.push(("damm_compounding_buy", J::Arr(comp_buy)));
    out.push(("damm_compounding_max_quote_in", J::Arr(comp_max)));

    // impact_target_sqrt_price and min_out_floor
    let mut target = Vec::new();
    for sqrt in prices.iter().copied().chain([u128::MAX - 7]) {
        for bps in [0u16, 1, 10, 100, 1_000, u16::MAX] {
            target.push(case(
                vec![sqrt.j(), bps.j()],
                math::impact_target_sqrt_price(sqrt, bps).j(),
            ));
        }
    }
    out.push(("impact_target_sqrt_price", J::Arr(target)));
    let mut floor = Vec::new();
    for out_amount in [0u64, 1, 999, 1_000, 1_001, 1 << 53, u64::MAX, g.sized()] {
        for bps in [0u16, 50, 300, 2_000, 9_999, 10_000, 10_001, u16::MAX] {
            floor.push(case(
                vec![out_amount.j(), bps.j()],
                math::min_out_floor(out_amount, bps).j(),
            ));
        }
    }
    out.push(("min_out_floor", J::Arr(floor)));

    // Security review (added later): fixed grids, so the earlier vectors keep their values.
    let mut circulating = Vec::new();
    for (supply, held) in [
        (0u64, 0u64),
        (1, 0),
        (0, 1),
        (1_000, 300),
        (1_000, 1_000),
        (1_000, 5_000),
        (1 << 53, 7),
        (999_999_999_999, 123_456_789),
        (u64::MAX, 0),
        (u64::MAX, 1),
        (u64::MAX, u64::MAX),
    ] {
        circulating.push(case(
            vec![supply.j(), held.j()],
            math::circulating_supply(supply, held).j(),
        ));
    }
    out.push(("circulating_supply", J::Arr(circulating)));
    let mut fee_floor = Vec::new();
    for mode in [0u8, 1, 2, 3] {
        for (cliff, periods, reduction) in [
            (10_000_000u64, 0u16, 0u64),
            (50_000_000, 40, 1_000_000),
            (5_000_000, 10, 1_000_000),
            (500_000_000, 10, 1_000),
            (500_000_000, 3, 10_000),
            (990_000_000, u16::MAX, 1),
            (990_000_000, 1_000, 37),
            (2_500_000, 7, 9),
            (0, 5, 5),
            (u64::MAX, 1, 1),
            (u64::MAX, u16::MAX, u64::MAX),
        ] {
            fee_floor.push(case(
                vec![mode.j(), cliff.j(), periods.j(), reduction.j()],
                math::dbc_min_base_fee_numerator(mode, cliff, periods, reduction).j(),
            ));
        }
    }
    out.push(("dbc_min_base_fee_numerator", J::Arr(fee_floor)));
    let mut migrated = Vec::new();
    for option in 0u8..=7 {
        for (bps, mode) in [(0u16, 0u8), (10, 0), (250, 1), (250, 3), (u16::MAX, 4)] {
            migrated.push(case(
                vec![option.j(), bps.j(), mode.j()],
                math::dbc_migrated_fee_bps(option, bps, mode).j(),
            ));
        }
    }
    out.push(("dbc_migrated_fee_bps", J::Arr(migrated)));
    let mut venue_floor = Vec::new();
    for curve in [
        0u64,
        99_999,
        100_000,
        2_500_000,
        2_599_999,
        10_000_000,
        u64::MAX,
    ] {
        for pool_bps in [0u16, 10, 25, 100, u16::MAX] {
            venue_floor.push(case(
                vec![curve.j(), pool_bps.j()],
                math::venue_fee_floor_bps(curve, pool_bps).j(),
            ));
        }
    }
    out.push(("venue_fee_floor_bps", J::Arr(venue_floor)));
    let mut bound = Vec::new();
    for floor in [
        0u16,
        1,
        4,
        5,
        25,
        30,
        100,
        499,
        500,
        501,
        600,
        1_000,
        u16::MAX,
    ] {
        bound.push(case(vec![floor.j()], math::max_impact_bound(floor).j()));
    }
    out.push(("max_impact_bound", J::Arr(bound)));
    out
}

// ─── DBC launch configs (register_revenue_token's config checks) ───────────

/// A DBC `PoolConfig` buffer with only the fields `check_launch_config` reads set.
fn dbc_config_bytes(c: &LaunchConfig) -> Vec<u8> {
    let mut d = vec![0u8; epoch::meteora_account::DBC_POOL_CONFIG_LEN];
    d[..8].copy_from_slice(&epoch::meteora_account::DBC_POOL_CONFIG_DISCRIMINATOR);
    d[8..40].copy_from_slice(c.quote_mint.as_ref());
    d[40..72].copy_from_slice(c.fee_claimer.as_ref());
    d[72..104].copy_from_slice(c.leftover_receiver.as_ref());
    d[104..112].copy_from_slice(&c.cliff.to_le_bytes());
    d[112..120].copy_from_slice(&c.period_frequency.to_le_bytes());
    d[120..128].copy_from_slice(&c.reduction.to_le_bytes());
    d[128..130].copy_from_slice(&c.periods.to_le_bytes());
    d[130] = c.fee_mode;
    d[185] = c.lp[2];
    d[201] = c.lp[5];
    d[233] = c.migration_option;
    d[237] = c.token_type;
    d[239] = c.lp[0];
    d[240] = c.lp[1];
    d[241] = c.lp[3];
    d[242] = c.lp[4];
    d[243] = c.migration_fee_option;
    d[244] = c.fixed_supply;
    d[362..364].copy_from_slice(&c.migrated_bps.to_le_bytes());
    d[364] = c.migrated_mode;
    d
}

#[derive(Clone, Copy)]
struct LaunchConfig {
    quote_mint: Pubkey,
    fee_claimer: Pubkey,
    leftover_receiver: Pubkey,
    cliff: u64,
    period_frequency: u64,
    reduction: u64,
    periods: u16,
    fee_mode: u8,
    /// partner permanent, partner unlocked, partner vesting, creator permanent, creator unlocked, creator vesting
    lp: [u8; 6],
    migration_option: u8,
    token_type: u8,
    migration_fee_option: u8,
    fixed_supply: u8,
    migrated_bps: u16,
    migrated_mode: u8,
}

fn launch_configs(program_id: &Pubkey) -> J {
    let pool = addr(&[POOL_SEED], program_id);
    let treasury = addr(&[PARTNER_TREASURY_SEED, pool.as_ref()], program_id);
    let other = k(77);
    let base = LaunchConfig {
        quote_mint: NATIVE_MINT,
        fee_claimer: treasury,
        leftover_receiver: treasury,
        cliff: 10_000_000,
        period_frequency: 0,
        reduction: 0,
        periods: 0,
        fee_mode: 0,
        lp: [100, 0, 0, 0, 0, 0],
        migration_option: 1,
        token_type: 0,
        migration_fee_option: 2,
        fixed_supply: 1,
        migrated_bps: 0,
        migrated_mode: 0,
    };
    let cases: Vec<(&str, LaunchConfig)> = vec![
        ("epoch_preset", base),
        (
            "split_locked_lp",
            LaunchConfig {
                lp: [60, 0, 0, 40, 0, 0],
                ..base
            },
        ),
        (
            "low_fees_customizable",
            LaunchConfig {
                cliff: 2_500_000,
                migration_fee_option: 6,
                migrated_bps: 10,
                ..base
            },
        ),
        (
            "decaying_curve_fee_ok",
            LaunchConfig {
                cliff: 50_000_000,
                periods: 10,
                period_frequency: 60,
                reduction: 4_950_000,
                ..base
            },
        ),
        (
            "exponential_curve_fee",
            LaunchConfig {
                cliff: 500_000_000,
                periods: 10,
                period_frequency: 60,
                reduction: 1_000,
                fee_mode: 1,
                ..base
            },
        ),
        (
            "rate_limiter",
            LaunchConfig {
                cliff: 2_500_000,
                fee_mode: 2,
                periods: 50,
                reduction: 1_000_000_000,
                ..base
            },
        ),
        (
            "not_fixed_supply_any_receiver",
            LaunchConfig {
                fixed_supply: 0,
                leftover_receiver: other,
                ..base
            },
        ),
        (
            "quote_not_sol",
            LaunchConfig {
                quote_mint: other,
                ..base
            },
        ),
        (
            "damm_v1",
            LaunchConfig {
                migration_option: 0,
                ..base
            },
        ),
        (
            "token_2022",
            LaunchConfig {
                token_type: 1,
                ..base
            },
        ),
        (
            "foreign_fee_claimer",
            LaunchConfig {
                fee_claimer: other,
                ..base
            },
        ),
        (
            "foreign_leftover_receiver",
            LaunchConfig {
                leftover_receiver: other,
                ..base
            },
        ),
        (
            "creator_lp_unlocked",
            LaunchConfig {
                lp: [50, 0, 0, 0, 50, 0],
                ..base
            },
        ),
        (
            "partner_lp_vesting",
            LaunchConfig {
                lp: [90, 0, 10, 0, 0, 0],
                ..base
            },
        ),
        (
            "curve_fee_decays_too_low",
            LaunchConfig {
                cliff: 50_000_000,
                periods: 10,
                period_frequency: 60,
                reduction: 4_960_000,
                ..base
            },
        ),
        (
            "unknown_fee_mode",
            LaunchConfig {
                fee_mode: 9,
                ..base
            },
        ),
        (
            "market_cap_scheduler",
            LaunchConfig {
                migration_fee_option: 6,
                migrated_bps: 100,
                migrated_mode: 3,
                ..base
            },
        ),
        (
            "customizable_too_low",
            LaunchConfig {
                migration_fee_option: 6,
                migrated_bps: 4,
                ..base
            },
        ),
        (
            "unknown_migration_option",
            LaunchConfig {
                migration_fee_option: 7,
                ..base
            },
        ),
    ];
    J::Arr(
        cases
            .into_iter()
            .map(|(label, c)| {
                let bytes = dbc_config_bytes(&c);
                let parsed = epoch::meteora_account::DbcConfig::parse(&bytes).expect("parses");
                let result = match epoch::instructions::check_launch_config(&parsed, &treasury) {
                    Ok(floor) => obj(vec![
                        ("feeFloorBps", floor.j()),
                        ("maxImpactBound", math::max_impact_bound(floor).j()),
                    ]),
                    Err(anchor_lang::error::Error::AnchorError(e)) => {
                        obj(vec![("error", s(e.error_name))])
                    }
                    Err(e) => panic!("{e:?}"),
                };
                obj(vec![
                    ("label", s(label)),
                    ("treasury", treasury.j()),
                    ("data", hex(&bytes)),
                    ("result", result),
                ])
            })
            .collect(),
    )
}

// ─── Main ──────────────────────────────────────────────────────────────────

fn main() {
    let out_path = std::env::args().nth(1).map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/__fixtures__/rust-vectors.json"),
        PathBuf::from,
    );

    let program_id = Pubkey::new_from_array([42u8; 32]);
    let mut g = Gen(0x0e70_c4e9_5d1c_0001);
    // Revenue tokens (added later) draw from their own sequence, so the older vectors keep
    // their values and the fixture diff shows only what changed.
    let mut g2 = Gen(0x0e70_c4e9_5d1c_0002);
    // Treasury claims (added after that): a third sequence, for the same reason.
    let mut g3 = Gen(0x0e70_c4e9_5d1c_0003);
    // Validator history: a fourth sequence.
    let mut g4 = Gen(0x0e70_c4e9_5d1c_0004);

    let mut ixs: Vec<J> = instructions(&mut g, program_id)
        .into_iter()
        .map(Ix::json)
        .collect();
    ixs.push(sweep_declared_id().json());
    ixs.extend(
        revenue_instructions(&mut g2, program_id)
            .into_iter()
            .map(Ix::json),
    );
    ixs.extend(
        treasury_instructions(&mut g3, program_id)
            .into_iter()
            .map(Ix::json),
    );
    ixs.extend(
        history_instructions(&mut g4, program_id)
            .into_iter()
            .map(Ix::json),
    );

    let root = obj(vec![
        (
            "_comment",
            s("Generated by packages/epoch-sdk/vectors (cargo run --offline --release). Do not edit by hand."),
        ),
        ("anchorLang", s("1.2.0")),
        ("programId", program_id.j()),
        ("declaredProgramId", epoch::ID.j()),
        ("errorCodeOffset", J::Int(i64::from(anchor_lang::error::ERROR_CODE_OFFSET))),
        (
            "seeds",
            obj(vec![
                ("pool", s(String::from_utf8_lossy(POOL_SEED))),
                ("vault", s(String::from_utf8_lossy(VAULT_SEED))),
                ("lender", s(String::from_utf8_lossy(LENDER_SEED))),
                ("withdraw", s(String::from_utf8_lossy(WITHDRAW_SEED))),
                ("position", s(String::from_utf8_lossy(POSITION_SEED))),
                ("voteAuth", s(String::from_utf8_lossy(VOTE_AUTH_SEED))),
                ("escrow", s(String::from_utf8_lossy(ESCROW_SEED))),
                ("advance", s(String::from_utf8_lossy(ADVANCE_SEED))),
                ("feeIndex", s(String::from_utf8_lossy(FEE_INDEX_SEED))),
                ("quote", s(String::from_utf8_lossy(QUOTE_SEED))),
                ("swap", s(String::from_utf8_lossy(SWAP_SEED))),
                ("revenueToken", s(String::from_utf8_lossy(REVENUE_TOKEN_SEED))),
                ("buyback", s(String::from_utf8_lossy(BUYBACK_SEED))),
                ("buybackWsol", s(String::from_utf8_lossy(BUYBACK_WSOL_SEED))),
                ("buybackTokens", s(String::from_utf8_lossy(BUYBACK_TOKENS_SEED))),
                ("partnerTreasury", s(String::from_utf8_lossy(PARTNER_TREASURY_SEED))),
                ("treasuryWsol", s(String::from_utf8_lossy(TREASURY_WSOL_SEED))),
                ("history", s(String::from_utf8_lossy(HISTORY_SEED))),
                ("scoreConfig", s(String::from_utf8_lossy(SCORE_CONFIG_SEED))),
            ]),
        ),
        (
            "constants",
            obj(vec![
                ("BPS_DENOMINATOR", J::Int(BPS_DENOMINATOR as i64)),
                ("LAMPORTS_PER_SOL", J::Int(LAMPORTS_PER_SOL as i64)),
                ("MAX_SCORE", MAX_SCORE.j()),
                ("VIRTUAL_SHARES", s(VIRTUAL_SHARES)),
                ("VIRTUAL_ASSETS", s(VIRTUAL_ASSETS)),
                ("REVENUE_WINDOW", J::Int(REVENUE_WINDOW as i64)),
                ("MIN_REVENUE_HISTORY", MIN_REVENUE_HISTORY.j()),
                ("DEFAULT_AFTER_LATE_EPOCHS", DEFAULT_AFTER_LATE_EPOCHS.j()),
                ("INDEX_HISTORY", J::Int(INDEX_HISTORY as i64)),
                ("VOTE_PROGRAM_ID", VOTE_PROGRAM_ID.j()),
                ("MIN_SHARE_BPS", MIN_SHARE_BPS.j()),
                ("MAX_SHARE_BPS", MAX_SHARE_BPS.j()),
                ("MIN_TERM_EPOCHS", MIN_TERM_EPOCHS.j()),
                ("MAX_TERM_EPOCHS", MAX_TERM_EPOCHS.j()),
                ("DEFAULT_BUYBACK_SLICES", DEFAULT_BUYBACK_SLICES.j()),
                ("DEFAULT_BUYBACK_WINDOW_SLOTS", DEFAULT_BUYBACK_WINDOW_SLOTS.j()),
                ("MAX_BUYBACK_SLICES", MAX_BUYBACK_SLICES.j()),
                ("DEFAULT_MAX_SLIPPAGE_BPS", DEFAULT_MAX_SLIPPAGE_BPS.j()),
                ("MIN_MAX_SLIPPAGE_BPS", MIN_MAX_SLIPPAGE_BPS.j()),
                ("MAX_MAX_SLIPPAGE_BPS", MAX_MAX_SLIPPAGE_BPS.j()),
                ("DEFAULT_MAX_IMPACT_BPS", DEFAULT_MAX_IMPACT_BPS.j()),
                ("MIN_MAX_IMPACT_BPS", MIN_MAX_IMPACT_BPS.j()),
                ("MAX_MAX_IMPACT_BPS", MAX_MAX_IMPACT_BPS.j()),
                ("MAX_CLOSE_DUST_LAMPORTS", MAX_CLOSE_DUST_LAMPORTS.j()),
                ("REDEEM_GRACE_EPOCHS", REDEEM_GRACE_EPOCHS.j()),
                ("FLAG_BUYBACKS_PAUSED", FLAG_BUYBACKS_PAUSED.j()),
                ("FLAG_REDEEM_DURING_TERM", FLAG_REDEEM_DURING_TERM.j()),
                ("DBC_PROGRAM_ID", DBC_PROGRAM_ID.j()),
                ("DBC_POOL_AUTHORITY", DBC_POOL_AUTHORITY.j()),
                ("DBC_EVENT_AUTHORITY", DBC_EVENT_AUTHORITY.j()),
                ("CP_AMM_PROGRAM_ID", CP_AMM_PROGRAM_ID.j()),
                ("CP_AMM_POOL_AUTHORITY", CP_AMM_POOL_AUTHORITY.j()),
                ("CP_AMM_EVENT_AUTHORITY", CP_AMM_EVENT_AUTHORITY.j()),
                ("TOKEN_PROGRAM_ID", TOKEN_PROGRAM_ID.j()),
                ("ASSOCIATED_TOKEN_PROGRAM_ID", ASSOCIATED_TOKEN_PROGRAM_ID.j()),
                ("NATIVE_MINT", NATIVE_MINT.j()),
                ("INSTRUCTIONS_SYSVAR_ID", INSTRUCTIONS_SYSVAR_ID.j()),
                ("TOKEN_2022_PROGRAM_ID", TOKEN_2022_PROGRAM_ID.j()),
                ("CP_AMM_POSITION_NFT_ACCOUNT_SEED", s(String::from_utf8_lossy(CP_AMM_POSITION_NFT_ACCOUNT_SEED))),
                ("DBC_MIGRATION_PROGRESS_CREATED_POOL", DBC_MIGRATION_PROGRESS_CREATED_POOL.j()),
                ("DBC_PARTNER_MIGRATION_FEE_MASK", DBC_PARTNER_MIGRATION_FEE_MASK.j()),
                ("DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE", J::Int(DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE as i64)),
                ("HISTORY_LEN", J::Int(HISTORY_LEN as i64)),
                ("TVC_CREDITS_PER_SLOT", TVC_CREDITS_PER_SLOT.j()),
                ("DELINQUENT_SLOT_DISTANCE", DELINQUENT_SLOT_DISTANCE.j()),
                ("HEDGE_EPOCHS_AHEAD", HEDGE_EPOCHS_AHEAD.j()),
                ("HEDGE_MIN_NOTIONAL_BPS", HEDGE_MIN_NOTIONAL_BPS.j()),
                ("DEFAULT_CREDITS_WINDOW_EPOCHS", DEFAULT_CREDITS_WINDOW_EPOCHS.j()),
                ("MAX_CREDITS_WINDOW_EPOCHS", MAX_CREDITS_WINDOW_EPOCHS.j()),
                ("DEFAULT_CREDITS_REFERENCE_BPS", DEFAULT_CREDITS_REFERENCE_BPS.j()),
                ("MIN_CREDITS_REFERENCE_BPS", MIN_CREDITS_REFERENCE_BPS.j()),
                ("DEFAULT_MAX_COPY_AGE_SLOTS", DEFAULT_MAX_COPY_AGE_SLOTS.j()),
                ("MIN_MAX_COPY_AGE_SLOTS", MIN_MAX_COPY_AGE_SLOTS.j()),
                ("MAX_MAX_COPY_AGE_SLOTS", MAX_MAX_COPY_AGE_SLOTS.j()),
                ("JITO_TIP_DISTRIBUTION_PROGRAM_ID", JITO_TIP_DISTRIBUTION_PROGRAM_ID.j()),
                ("TIP_DISTRIBUTION_ACCOUNT_SEED", s(String::from_utf8_lossy(TIP_DISTRIBUTION_ACCOUNT_SEED))),
                ("JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID", JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID.j()),
                ("PF_DISTRIBUTION_ACCOUNT_SEED", s(String::from_utf8_lossy(PF_DISTRIBUTION_ACCOUNT_SEED))),
            ]),
        ),
        ("accounts", accounts(&mut g, &mut g2, &mut g4)),
        ("instructions", J::Arr(ixs)),
        ("events", events(&mut g, &mut g2, &mut g3, &mut g4)),
        ("pdas", pdas(&program_id)),
        ("errors", errors()),
        ("math", math(&mut g, &mut g2, &mut g3)),
        ("launchConfigs", launch_configs(&program_id)),
    ]);

    let mut text = String::new();
    root.pretty(&mut text, 0);
    text.push('\n');
    if let Some(dir) = out_path.parent() {
        fs::create_dir_all(dir).expect("create fixture dir");
    }
    fs::write(&out_path, &text).expect("write vectors");
    println!("wrote {} ({} bytes)", out_path.display(), text.len());
}
