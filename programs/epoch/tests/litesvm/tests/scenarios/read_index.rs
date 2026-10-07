//! Reading the Fee Index from another program (docs/FEE_INDEX_METHODOLOGY.md,
//! "Reading the index on chain"): `consumer` is the code a reader writes, kept
//! here so it compiles against the program crate; the tests run its direct
//! read on a real `FeeIndex` account and `get_sfi` itself.

use anchor_lang::prelude::*;
use epoch::errors::EpochError;
use epoch_litesvm_tests::context::{code, TestContext};
use epoch_litesvm_tests::pda::TEST_PROGRAM_ID;
use epoch_litesvm_tests::{ix, pda, ExpectErr, TxResult};

/// What a reading program needs, with `epoch = { features = ["cpi"] }` as a dependency.
mod consumer {
    use anchor_lang::prelude::*;
    use epoch::state::FeeIndex;

    /// The FeeIndex PDA: `["fee_index", pool]`, the pool being `["pool"]`, both under Epoch's program id.
    pub fn fee_index_address(epoch_program: &Pubkey) -> Pubkey {
        let (pool, _) = Pubkey::find_program_address(&[b"pool"], epoch_program);
        Pubkey::find_program_address(&[b"fee_index", pool.as_ref()], epoch_program).0
    }

    /// Read the account directly: check the address and the owner, then take only a final value
    /// (`value_for` answers the last final epoch and the 16 before it, never a pending proposal).
    pub fn final_value(
        account: &AccountInfo,
        epoch_program: &Pubkey,
        epoch: u64,
    ) -> Result<Option<u64>> {
        require_keys_eq!(account.key(), fee_index_address(epoch_program));
        require_keys_eq!(*account.owner, *epoch_program);
        let index = FeeIndex::try_deserialize(&mut &account.try_borrow_data()?[..])?;
        Ok(index.value_for(epoch))
    }

    /// Or ask the program: `get_sfi(epoch)` returns the final value as return data and fails with
    /// `IndexMissing` for an epoch that is not final. The Epoch program account must be in the
    /// instruction's accounts for the CPI.
    #[allow(dead_code)] // compiled here; it runs inside a reading program
    pub fn final_value_by_cpi<'info>(
        epoch_program: &Pubkey,
        fee_index: AccountInfo<'info>,
        epoch: u64,
    ) -> Result<u64> {
        let accounts = epoch::cpi::accounts::GetSfi { fee_index };
        let value = epoch::cpi::get_sfi(CpiContext::new(*epoch_program, accounts), epoch)?;
        Ok(value.get())
    }
}

/// `get_sfi(epoch)` sent by itself (the harness's fee payer signs); the value comes back as return data.
fn get_sfi(ctx: &mut TestContext, epoch: u64) -> TxResult {
    ctx.send_as(&[ix::get_sfi(epoch)], &[])
}

fn returned(ok: &epoch_litesvm_tests::TxOk) -> u64 {
    let ret = &ok.meta.return_data;
    assert_eq!(ret.program_id, TEST_PROGRAM_ID);
    u64::from_le_bytes(ret.data[..8].try_into().unwrap())
}

/// The direct read, on the account as LiteSVM holds it.
fn read_directly(ctx: &TestContext, epoch: u64) -> Option<u64> {
    let key = pda::fee_index();
    let mut acc = ctx.account(&key).unwrap();
    let mut lamports = acc.lamports;
    let info = AccountInfo::new(
        &key,
        false,
        false,
        &mut lamports,
        &mut acc.data,
        &acc.owner,
        false,
    );
    consumer::final_value(&info, &TEST_PROGRAM_ID, epoch).unwrap()
}

#[test]
fn readers_get_final_values_only() {
    let mut ctx = TestContext::with_pool();
    let admin = ctx.key("admin");
    let publisher = ctx.wallet("publisher");
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, 10, 2_000)],
        &["admin"],
    )
    .unwrap();
    assert_eq!(
        consumer::fee_index_address(&TEST_PROGRAM_ID),
        pda::fee_index()
    );

    // A proposal inside its window is not a value.
    ctx.send_as(
        &[ix::post_index(publisher, 800, 1_400, [1; 32])],
        &["publisher"],
    )
    .unwrap();
    get_sfi(&mut ctx, 800).fails_with(code(EpochError::IndexMissing));
    assert_eq!(read_directly(&ctx, 800), None);

    // Final: both reads answer, for this epoch and, once newer values are final, from the history.
    ctx.advance_slots(10);
    let cranker = ctx.wallet("crank");
    ctx.send_as(&[ix::finalize_index(cranker)], &["crank"])
        .unwrap();
    assert_eq!(returned(&get_sfi(&mut ctx, 800).unwrap()), 1_400);
    assert_eq!(read_directly(&ctx, 800), Some(1_400));
    ctx.warp_to_epoch(801);
    ctx.send_as(
        &[ix::post_index(publisher, 801, 1_500, [2; 32])],
        &["publisher"],
    )
    .unwrap();
    ctx.advance_slots(10);
    ctx.send_as(&[ix::finalize_index(cranker)], &["crank"])
        .unwrap();
    assert_eq!(returned(&get_sfi(&mut ctx, 801).unwrap()), 1_500);
    assert_eq!(returned(&get_sfi(&mut ctx, 800).unwrap()), 1_400);
    assert_eq!(read_directly(&ctx, 800), Some(1_400));

    // Never posted.
    get_sfi(&mut ctx, 799).fails_with(code(EpochError::IndexMissing));
    assert_eq!(read_directly(&ctx, 799), None);
}
