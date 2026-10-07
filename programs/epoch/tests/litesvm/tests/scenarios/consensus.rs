//! Fee Index operator consensus: the registry (`initialize_index_operators`,
//! `add_index_operator`, `remove_index_operator`, `set_index_operator_weight`,
//! `set_index_consensus`), ballots (`cast_index_vote`, `submit_index_ballot`,
//! `reset_index_ballot`, `close_index_ballot`), the one-operator `post_index`
//! shortcut and the bound that keeps every proposal at or below the cluster's
//! epoch. Values go through the same `FeeIndex` proposal, dispute window and
//! `finalize_index` as a single publisher's.

use anchor_lang::Space;
use epoch::errors::EpochError;
use epoch::events::{
    IndexBallotClosed, IndexBallotOpened, IndexBallotSubmitted, IndexConsensusReached,
    IndexConsensusSet, IndexFinalized, IndexOperatorAdded, IndexOperatorRemoved,
    IndexOperatorWeightSet, IndexOperatorsInitialized, IndexProposed, IndexVoteCast,
};
use epoch::state::{FeeIndex, IndexBallot, IndexOperators};
use epoch_litesvm_tests::context::{code, TestContext};
use epoch_litesvm_tests::{ix, pda, ExpectErr, TxResult};

const WINDOW: u64 = 50;
const MAX_MOVE_BPS: u16 = 2_000;
const TWO_THIRDS: u16 = 6_667;
const ONE_PERCENT: u16 = 100;

fn hash(n: u8) -> [u8; 32] {
    [n; 32]
}

/// A pool and its Fee Index (`publisher` proposes), no registry yet; the cluster at epoch 800.
fn with_index() -> TestContext {
    let mut ctx = TestContext::with_pool();
    let admin = ctx.key("admin");
    let publisher = ctx.wallet("publisher");
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, WINDOW, MAX_MOVE_BPS)],
        &["admin"],
    )
    .unwrap();
    ctx
}

/// `with_index` plus a registry of `names`, weight 1 each, two-thirds threshold, 1% tolerance.
fn with_operators(names: &[&str]) -> TestContext {
    let mut ctx = with_index();
    let admin = ctx.key("admin");
    let mut ixs = vec![ix::initialize_index_operators(
        admin,
        TWO_THIRDS,
        ONE_PERCENT,
    )];
    for name in names {
        let key = ctx.wallet(name);
        ixs.push(ix::add_index_operator(admin, key, 1));
    }
    let ok = ctx.send_as(&ixs, &["admin"]).unwrap();
    let init: IndexOperatorsInitialized = ok.event();
    assert_eq!(
        (init.index_operators, init.threshold_bps, init.tolerance_bps),
        (pda::index_operators(), TWO_THIRDS, ONE_PERCENT)
    );
    assert_eq!(ok.events::<IndexOperatorAdded>().len(), names.len());
    ctx
}

fn index(ctx: &TestContext) -> FeeIndex {
    ctx.get(&pda::fee_index())
}

fn ballot(ctx: &TestContext, epoch: u64) -> IndexBallot {
    ctx.get(&pda::index_ballot(epoch))
}

fn registry(ctx: &TestContext) -> IndexOperators {
    ctx.get(&pda::index_operators())
}

/// `operator` votes, the `ballot-payer` wallet paying the rent if the vote opens the ballot.
fn vote(ctx: &mut TestContext, operator: &str, epoch: u64, value: u64, h: u8) -> TxResult {
    let payer = ctx.wallet("ballot-payer");
    let op = ctx.key(operator);
    ctx.send_as(
        &[ix::cast_index_vote(payer, op, epoch, value, hash(h))],
        &["ballot-payer", operator],
    )
}

fn finalize(ctx: &mut TestContext) -> TxResult {
    let cranker = ctx.wallet("crank");
    ctx.send_as(&[ix::finalize_index(cranker)], &["crank"])
}

fn after_window(ctx: &mut TestContext) -> IndexFinalized {
    ctx.advance_slots(index(ctx).dispute_window_slots);
    finalize(ctx).unwrap().event()
}

fn close(ctx: &mut TestContext, epoch: u64, payer: &str) -> TxResult {
    let cranker = ctx.wallet("crank");
    let payer = ctx.key(payer);
    ctx.send_as(&[ix::close_index_ballot(cranker, epoch, payer)], &["crank"])
}

fn ballot_rent(ctx: &TestContext) -> u64 {
    ctx.rent_exempt(8 + IndexBallot::INIT_SPACE)
}

#[test]
fn three_operators_two_agree_the_dissenter_is_recorded_a_veto_reopens_close_refunds() {
    let mut ctx = with_operators(&["op1", "op2", "op3"]);
    let reg = registry(&ctx);
    assert_eq!((reg.operator_count, reg.total_weight), (3, 3));
    // Consensus is on: the registry PDA, which no key can sign for, is the publisher.
    assert_eq!(index(&ctx).publisher, pda::index_operators());
    let publisher = ctx.key("publisher");
    ctx.send_as(
        &[ix::post_index(publisher, 800, 1_000, hash(9))],
        &["publisher"],
    )
    .fails_with(code(EpochError::NotPublisher));
    // No ballot for an epoch the cluster has not reached.
    vote(&mut ctx, "op1", 801, 1_000, 1).fails_with(code(EpochError::IndexEpochNotStarted));
    assert!(!ctx.exists(&pda::index_ballot(801)));

    // op1 opens the ballot (the payer pays its rent) with a snapshot of the registry.
    let payer = ctx.wallet("ballot-payer");
    let before = ctx.lamports(&payer);
    let ok = vote(&mut ctx, "op1", 800, 1_000, 1).unwrap();
    let opened: IndexBallotOpened = ok.event();
    assert_eq!(
        (
            opened.epoch,
            opened.round,
            opened.operators.len(),
            opened.reset
        ),
        (800, 0, 3, false)
    );
    assert_eq!(ctx.lamports(&payer), before - ballot_rent(&ctx));
    assert_eq!(ballot(&ctx, 800).payer, payer);

    // A dissenter: 1,000 and 1,500 do not agree, nothing is proposed.
    let cast: IndexVoteCast = vote(&mut ctx, "op3", 800, 1_500, 3).unwrap().event();
    assert_eq!(
        (cast.median_value, cast.agreeing_weight, cast.agrees),
        (1_000, 1, false)
    );
    assert!(!index(&ctx).has_proposal);

    // 1,004 joins op1 inside 1% of the weighted median: two of three agree on 1,004. Two thirds of
    // the weight is 6,666.67 bps, which meets 6,667 (the share is rounded up to a whole bps).
    let ok = vote(&mut ctx, "op2", 800, 1_004, 2).unwrap();
    let reached: IndexConsensusReached = ok.event();
    assert_eq!(
        (
            reached.value,
            reached.inputs_hash,
            reached.agreeing_weight,
            reached.proposed
        ),
        (1_004, hash(2), 2, true)
    );
    let proposed: IndexProposed = ok.event();
    assert_eq!((proposed.epoch, proposed.value), (800, 1_004));
    let fi = index(&ctx);
    assert!(fi.has_proposal);
    assert_eq!((fi.proposed_epoch, fi.proposed_value), (800, 1_004));
    // Every vote's deviation from the agreed value is on the record.
    let b = ballot(&ctx, 800);
    let by = |name: &str| {
        *b.votes
            .iter()
            .find(|x| x.operator == ctx.key(name))
            .unwrap()
    };
    assert_eq!((by("op1").deviation_bps, by("op1").agrees), (40, true));
    assert_eq!((by("op2").deviation_bps, by("op2").agrees), (0, true));
    assert_eq!((by("op3").deviation_bps, by("op3").agrees), (4_941, false));
    assert_eq!((b.consensus_value, b.votes_cast), (1_004, 3));

    // After consensus a cast vote is locked.
    vote(&mut ctx, "op1", 800, 1_001, 1).fails_with(code(EpochError::VoteLocked));

    // The admin vetoes inside the window; the next vote opens round 1 with a fresh snapshot.
    let admin = ctx.key("admin");
    ctx.send_as(&[ix::veto_index(admin)], &["admin"]).unwrap();
    assert!(!index(&ctx).has_proposal);
    let ok = vote(&mut ctx, "op1", 800, 1_002, 4).unwrap();
    let reopened: IndexBallotOpened = ok.event();
    assert_eq!((reopened.round, reopened.reset), (1, false));
    assert_eq!(ballot(&ctx, 800).votes_cast, 1);
    let ok = vote(&mut ctx, "op2", 800, 1_002, 5).unwrap();
    assert_eq!(ok.event::<IndexConsensusReached>().round, 1);
    let finalized = after_window(&mut ctx);
    assert_eq!((finalized.epoch, finalized.value), (800, 1_002));
    assert_eq!(index(&ctx).value_for(800), Some(1_002));

    // Next epoch: two agree at once, the third votes late and changes nothing.
    ctx.warp_to_epoch(801);
    vote(&mut ctx, "op1", 801, 1_100, 6).unwrap();
    let ok = vote(&mut ctx, "op2", 801, 1_100, 7).unwrap();
    assert!(ok.event::<IndexConsensusReached>().proposed);
    let late: IndexVoteCast = vote(&mut ctx, "op3", 801, 1_200, 8).unwrap().event();
    assert_eq!(
        (late.late, late.agrees, late.deviation_bps),
        (true, false, 910)
    );
    assert_eq!(index(&ctx).proposed_value, 1_100);

    // Closing: not while the epoch can still change, only to the payer, then the rent comes back.
    close(&mut ctx, 801, "ballot-payer").fails_with(code(EpochError::BallotNotClosable));
    close(&mut ctx, 800, "crank").fails_with(code(EpochError::BallotPayerMismatch));
    let before = ctx.lamports(&payer);
    let ok = close(&mut ctx, 800, "ballot-payer").unwrap();
    let closed: IndexBallotClosed = ok.event();
    assert_eq!(
        (closed.epoch, closed.round, closed.payer, closed.lamports),
        (800, 1, payer, ballot_rent(&ctx))
    );
    assert_eq!(ctx.lamports(&payer), before + ballot_rent(&ctx));
    assert!(!ctx.exists(&pda::index_ballot(800)));
}

#[test]
fn threshold_boundary_reset_queued_submit_and_skipped_over_close() {
    let mut ctx = with_index();
    let admin = ctx.key("admin");
    // Registry parameters stay in range.
    ctx.send_as(
        &[ix::initialize_index_operators(admin, 5_000, ONE_PERCENT)],
        &["admin"],
    )
    .fails_with(code(EpochError::InvalidConsensusParams));
    ctx.send_as(
        &[ix::initialize_index_operators(
            admin,
            TWO_THIRDS,
            ONE_PERCENT,
        )],
        &["admin"],
    )
    .unwrap();
    // An empty registry cannot open a ballot.
    ctx.wallet("op1");
    vote(&mut ctx, "op1", 800, 1_000, 1).fails_with(code(EpochError::NoIndexOperators));

    // Up to eight operators, each once, weight 1 to a total of 10,000.
    let keys: Vec<_> = (1..=9).map(|n| ctx.wallet(&format!("op{n}"))).collect();
    ctx.send_as(&[ix::add_index_operator(admin, keys[0], 0)], &["admin"])
        .fails_with(code(EpochError::InvalidOperatorWeight));
    ctx.send_as(
        &[ix::add_index_operator(admin, keys[0], 10_001)],
        &["admin"],
    )
    .fails_with(code(EpochError::InvalidOperatorWeight));
    for key in &keys[..8] {
        ctx.send_as(&[ix::add_index_operator(admin, *key, 1)], &["admin"])
            .unwrap();
    }
    ctx.send_as(&[ix::add_index_operator(admin, keys[0], 1)], &["admin"])
        .fails_with(code(EpochError::IndexOperatorExists));
    ctx.send_as(&[ix::add_index_operator(admin, keys[8], 1)], &["admin"])
        .fails_with(code(EpochError::IndexOperatorsFull));
    // Back to three: op4..op8 leave, the rest keep their order.
    for key in &keys[3..8] {
        let removed: IndexOperatorRemoved = ctx
            .send_as(&[ix::remove_index_operator(admin, *key)], &["admin"])
            .unwrap()
            .event();
        assert_eq!(removed.operator, *key);
    }
    ctx.send_as(&[ix::remove_index_operator(admin, keys[8])], &["admin"])
        .fails_with(code(EpochError::UnknownIndexOperator));
    let reg = registry(&ctx);
    assert_eq!((reg.operator_count, reg.total_weight), (3, 3));
    assert_eq!(
        reg.operators[..3].iter().map(|o| o.key).collect::<Vec<_>>(),
        keys[..3].to_vec()
    );
    // A weight change, and back.
    let set: IndexOperatorWeightSet = ctx
        .send_as(
            &[ix::set_index_operator_weight(admin, keys[2], 5)],
            &["admin"],
        )
        .unwrap()
        .event();
    assert_eq!((set.old_weight, set.weight, set.total_weight), (1, 5, 7));
    ctx.send_as(
        &[ix::set_index_operator_weight(admin, keys[2], 10_000)],
        &["admin"],
    )
    .fails_with(code(EpochError::InvalidOperatorWeight));
    ctx.send_as(
        &[ix::set_index_operator_weight(admin, keys[2], 1)],
        &["admin"],
    )
    .unwrap();

    // Just above two thirds, two of three equal operators are not enough.
    ctx.send_as(&[ix::set_index_consensus(admin, 10_000, 1_001)], &["admin"])
        .fails_with(code(EpochError::InvalidConsensusParams));
    let set: IndexConsensusSet = ctx
        .send_as(
            &[ix::set_index_consensus(admin, TWO_THIRDS + 1, ONE_PERCENT)],
            &["admin"],
        )
        .unwrap()
        .event();
    assert_eq!(set.threshold_bps, TWO_THIRDS + 1);
    ctx.warp_to_epoch(805);
    vote(&mut ctx, "op1", 801, 1_000, 1).unwrap();
    let cast: IndexVoteCast = vote(&mut ctx, "op2", 801, 1_000, 2).unwrap().event();
    assert_eq!(cast.agreeing_weight, 2);
    assert_eq!(ballot(&ctx, 801).consensus_slot, 0);
    assert!(!index(&ctx).has_proposal);

    // The admin goes back to two thirds and resets the stuck round: round 1, fresh snapshot,
    // votes cleared. Then two of three are consensus at the threshold.
    ctx.send_as(
        &[ix::set_index_consensus(admin, TWO_THIRDS, ONE_PERCENT)],
        &["admin"],
    )
    .unwrap();
    let ok = ctx
        .send_as(&[ix::reset_index_ballot(admin, 801)], &["admin"])
        .unwrap();
    let opened: IndexBallotOpened = ok.event();
    assert_eq!(
        (opened.round, opened.reset, opened.threshold_bps),
        (1, true, TWO_THIRDS)
    );
    assert_eq!(ballot(&ctx, 801).votes_cast, 0);
    vote(&mut ctx, "op1", 801, 1_000, 1).unwrap();
    vote(&mut ctx, "op2", 801, 1_000, 2).unwrap();
    assert!(index(&ctx).has_proposal);
    // A pending proposal cannot be reset (veto it first).
    ctx.send_as(&[ix::reset_index_ballot(admin, 801)], &["admin"])
        .fails_with(code(EpochError::BallotNotResettable));

    // 802 agrees while 801 is still in its window: queued, and nobody can submit it yet.
    vote(&mut ctx, "op1", 802, 1_010, 3).unwrap();
    let ok = vote(&mut ctx, "op2", 802, 1_010, 4).unwrap();
    assert!(!ok.event::<IndexConsensusReached>().proposed);
    let cranker = ctx.wallet("crank");
    ctx.send_as(&[ix::submit_index_ballot(cranker, 802)], &["crank"])
        .fails_with(code(EpochError::DisputeWindowOpen));
    after_window(&mut ctx);
    let ok = ctx
        .send_as(&[ix::submit_index_ballot(cranker, 802)], &["crank"])
        .unwrap();
    assert_eq!(ok.event::<IndexBallotSubmitted>().value, 1_010);
    assert_eq!(ok.event::<IndexProposed>().epoch, 802);
    ctx.send_as(&[ix::submit_index_ballot(cranker, 802)], &["crank"])
        .fails_with(code(EpochError::BallotAlreadyProposed));
    after_window(&mut ctx);

    // 803 never agrees; 804 does and becomes final, which skips 803 for good.
    vote(&mut ctx, "op1", 803, 1_000, 5).unwrap();
    ctx.send_as(&[ix::submit_index_ballot(cranker, 803)], &["crank"])
        .fails_with(code(EpochError::NoConsensus));
    close(&mut ctx, 803, "ballot-payer").fails_with(code(EpochError::BallotNotClosable));
    vote(&mut ctx, "op1", 804, 1_020, 6).unwrap();
    vote(&mut ctx, "op3", 804, 1_020, 7).unwrap();
    after_window(&mut ctx);
    assert_eq!(index(&ctx).epoch, 804);
    vote(&mut ctx, "op2", 803, 1_000, 8).fails_with(code(EpochError::IndexEpochNotNewer));
    let closed: IndexBallotClosed = close(&mut ctx, 803, "ballot-payer").unwrap().event();
    assert_eq!(closed.epoch, 803);
}

#[test]
fn one_operator_shortcut_and_the_cluster_epoch_bound() {
    let mut ctx = with_index();
    let admin = ctx.key("admin");
    let publisher = ctx.key("publisher");
    // A single publisher cannot post an epoch that has not started, near or far.
    for epoch in [801, 1_000_000] {
        ctx.send_as(
            &[ix::post_index(publisher, epoch, 1_000, hash(1))],
            &["publisher"],
        )
        .fails_with(code(EpochError::IndexEpochNotStarted));
    }

    // Two operators, then one leaves: the sole operator may post_index with the registry.
    let (op1, op2) = (ctx.wallet("op1"), ctx.wallet("op2"));
    ctx.send_as(
        &[
            ix::initialize_index_operators(admin, TWO_THIRDS, ONE_PERCENT),
            ix::add_index_operator(admin, op1, 1),
            ix::add_index_operator(admin, op2, 1),
        ],
        &["admin"],
    )
    .unwrap();
    // With two registered, neither may post alone.
    ctx.send_as(
        &[ix::post_index_as_operator(op1, 800, 1_000, hash(1))],
        &["op1"],
    )
    .fails_with(code(EpochError::NotPublisher));
    let removed: IndexOperatorRemoved = ctx
        .send_as(&[ix::remove_index_operator(admin, op2)], &["admin"])
        .unwrap()
        .event();
    assert_eq!((removed.operator_count, removed.total_weight), (1, 1));
    // The removed operator, and the sole one without the registry, are refused.
    ctx.send_as(
        &[ix::post_index_as_operator(op2, 800, 1_000, hash(2))],
        &["op2"],
    )
    .fails_with(code(EpochError::NotPublisher));
    ctx.send_as(&[ix::post_index(op1, 800, 1_000, hash(1))], &["op1"])
        .fails_with(code(EpochError::NotPublisher));
    // The cluster bound applies to the shortcut and to ballots too.
    ctx.send_as(
        &[ix::post_index_as_operator(op1, 1_000_000, 1_000, hash(1))],
        &["op1"],
    )
    .fails_with(code(EpochError::IndexEpochNotStarted));
    vote(&mut ctx, "op1", 1_000_000, 1_000, 1).fails_with(code(EpochError::IndexEpochNotStarted));
    let ok = ctx
        .send_as(
            &[ix::post_index_as_operator(op1, 800, 1_000, hash(1))],
            &["op1"],
        )
        .unwrap();
    assert_eq!(ok.event::<IndexProposed>().value, 1_000);
    after_window(&mut ctx);
    assert_eq!(index(&ctx).value_for(800), Some(1_000));

    // Switching back to a single publisher turns ballots off.
    ctx.send_as(
        &[ix::configure_index(admin, publisher, WINDOW, MAX_MOVE_BPS)],
        &["admin"],
    )
    .unwrap();
    ctx.warp_to_epoch(801);
    vote(&mut ctx, "op1", 801, 1_000, 1).fails_with(code(EpochError::ConsensusOff));
    ctx.send_as(
        &[ix::post_index(publisher, 801, 1_000, hash(3))],
        &["publisher"],
    )
    .unwrap();
}
