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
    instructions::{taker_pnl, ScoreUpdate},
    math::{self, CreditInputs, ScoreInputs},
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

fn position_json(a: &ValidatorPosition) -> J {
    fields!(a, ValidatorPosition {
        pool, vote, identity, operator, payout, original_withdrawer, bump, vote_auth_bump,
        escrow_bump, status, hedged, score, last_scored_epoch, revenue, revenue_head,
        revenue_count, last_swept_epoch, total_swept, total_remitted, bond_lamports, open_advance,
        advance_seq, late_epochs, inflation_commission_bps, block_commission_bps, onboarded_epoch,
    } skip { _reserved })
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
        // Non-zero so a stale tail left by a Some → None rewrite is visible garbage.
        _reserved: [0xc3; 32],
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

    // None on a fresh, zeroed account; partial ring (4 pushes).
    let mut fresh = position(g, PositionStatus::Active, false, None);
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

fn accounts(g: &mut Gen) -> J {
    J::Obj(vec![
        account_entry::<Pool>("Pool", pool_examples(g)),
        account_entry::<LenderShares>("LenderShares", lender_examples(g)),
        account_entry::<WithdrawRequest>("WithdrawRequest", withdraw_examples(g)),
        account_entry::<ValidatorPosition>("ValidatorPosition", position_examples(g)),
        account_entry::<Advance>("Advance", advance_examples(g)),
        account_entry::<FeeIndex>("FeeIndex", fee_index_examples(g)),
        account_entry::<FeeQuote>("FeeQuote", quote_examples(g)),
        account_entry::<SwapPosition>("SwapPosition", swap_examples(g)),
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

fn events(g: &mut Gen) -> J {
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
            position
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
            position
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
        },
        context {}
    );
    for (kind, bps) in [(0u8, 500u16), (1, 10_000)] {
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
        },
        context {}
    );
    out.pop().expect("one vector")
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
fn math(g: &mut Gen) -> J {
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

    obj(out)
}

// ─── Main ──────────────────────────────────────────────────────────────────

fn main() {
    let out_path = std::env::args().nth(1).map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/__fixtures__/rust-vectors.json"),
        PathBuf::from,
    );

    let program_id = Pubkey::new_from_array([42u8; 32]);
    let mut g = Gen(0x0e70_c4e9_5d1c_0001);

    let mut ixs: Vec<J> = instructions(&mut g, program_id)
        .into_iter()
        .map(Ix::json)
        .collect();
    ixs.push(sweep_declared_id().json());

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
            ]),
        ),
        ("accounts", accounts(&mut g)),
        ("instructions", J::Arr(ixs)),
        ("events", events(&mut g)),
        ("pdas", pdas(&program_id)),
        ("errors", errors()),
        ("math", math(&mut g)),
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
