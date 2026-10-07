//! [`TestContext`]: the SVM, the loaded program, role wallets, time and
//! transaction results.

use std::collections::BTreeMap;
use std::path::PathBuf;

use agave_feature_set::FeatureSet;
use anchor_lang::prelude::{Clock, EpochSchedule, Pubkey};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AnchorDeserialize, Discriminator};
use base64::Engine as _;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

use crate::pda::TEST_PROGRAM_ID;

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Slots per epoch in the test cluster (the mainnet value, without warm-up).
pub const SLOTS_PER_EPOCH: u64 = 432_000;

/// The first epoch of every test, far enough from zero that "epoch − n"
/// arithmetic in the program never sees an underflow it would not see live.
pub const START_EPOCH: u64 = 800;

pub fn sol(amount: f64) -> u64 {
    (amount * LAMPORTS_PER_SOL as f64).round() as u64
}

/// Path of the SBF build the suite loads: `$EPOCH_LITESVM_SO`, else
/// `<repo>/target/litesvm/epoch.so` (what `build-sbf.sh` writes).
pub fn program_so_path() -> PathBuf {
    if let Ok(p) = std::env::var("EPOCH_LITESVM_SO") {
        return PathBuf::from(p);
    }
    let target = std::env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../target"));
    target.join("litesvm/epoch.so")
}

/// A successful transaction.
#[derive(Debug)]
pub struct TxOk {
    pub meta: TransactionMetadata,
}

/// A failed transaction: the error and the program logs.
#[derive(Debug, Clone)]
pub struct TxErr {
    pub err: TransactionError,
    pub logs: Vec<String>,
}

pub type TxResult = Result<TxOk, TxErr>;

impl TxOk {
    pub fn logs(&self) -> &[String] {
        &self.meta.logs
    }

    pub fn compute_units(&self) -> u64 {
        self.meta.compute_units_consumed
    }

    /// Every `emit!`ted event of type `E`, in order.
    pub fn events<E: AnchorDeserialize + Discriminator>(&self) -> Vec<E> {
        self.meta
            .logs
            .iter()
            .filter_map(|line| line.strip_prefix("Program data: "))
            .filter_map(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
            .filter(|bytes| bytes.starts_with(E::DISCRIMINATOR))
            .map(|bytes| {
                E::deserialize(&mut &bytes[E::DISCRIMINATOR.len()..])
                    .expect("event matches its discriminator but does not deserialize")
            })
            .collect()
    }

    /// The single event of type `E`; panics when there is none or several.
    #[track_caller]
    pub fn event<E: AnchorDeserialize + Discriminator>(&self) -> E {
        let mut all = self.events::<E>();
        assert_eq!(
            all.len(),
            1,
            "expected exactly one {} event, logs:\n{}",
            std::any::type_name::<E>(),
            self.meta.logs.join("\n")
        );
        all.remove(0)
    }
}

impl TxErr {
    /// The custom program error code of the failing instruction, if any.
    pub fn custom_code(&self) -> Option<u32> {
        match &self.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
            _ => None,
        }
    }
}

/// Assertions on an expected failure.
pub trait ExpectErr {
    /// Fails unless the transaction failed with this program error.
    fn fails_with(self, code: impl Into<u32>) -> TxErr;
    /// Fails unless the transaction failed with this instruction error.
    fn fails_with_ix(self, err: InstructionError) -> TxErr;
}

impl ExpectErr for TxResult {
    #[track_caller]
    fn fails_with(self, code: impl Into<u32>) -> TxErr {
        let code = code.into();
        match self {
            Ok(ok) => panic!(
                "expected error {code}, transaction succeeded:\n{}",
                ok.meta.logs.join("\n")
            ),
            Err(e) => {
                assert_eq!(
                    e.custom_code(),
                    Some(code),
                    "wrong error {:?}, logs:\n{}",
                    e.err,
                    e.logs.join("\n")
                );
                e
            }
        }
    }

    #[track_caller]
    fn fails_with_ix(self, err: InstructionError) -> TxErr {
        match self {
            Ok(ok) => panic!(
                "expected {err:?}, transaction succeeded:\n{}",
                ok.meta.logs.join("\n")
            ),
            Err(e) => {
                match &e.err {
                    TransactionError::InstructionError(_, got) => {
                        assert_eq!(got, &err, "logs:\n{}", e.logs.join("\n"))
                    }
                    other => panic!(
                        "expected {err:?}, got {other:?}, logs:\n{}",
                        e.logs.join("\n")
                    ),
                }
                e
            }
        }
    }
}

/// An Epoch program error as the `u32` the runtime reports.
pub fn code(e: epoch::errors::EpochError) -> u32 {
    e.into()
}

/// An Anchor framework error (constraint failures and the like) as a `u32`.
pub fn anchor_code(e: anchor_lang::error::ErrorCode) -> u32 {
    e.into()
}

/// The test cluster: LiteSVM with the Epoch program loaded, every feature
/// active (the set `solana-test-validator` runs, which turns on the vote
/// program's SIMD-0185/0232/0291 instructions), a dedicated fee payer so role
/// balances move only by protocol effects, and named role wallets.
pub struct TestContext {
    pub svm: LiteSVM,
    pub payer: Keypair,
    wallets: BTreeMap<String, Keypair>,
}

impl TestContext {
    /// A fresh cluster at [`START_EPOCH`] with the program loaded.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new()
            .with_feature_set(FeatureSet::all_enabled())
            .with_builtins()
            .with_sysvars()
            .with_default_programs()
            .with_sigverify(true)
            .with_blockhash_check(true)
            .with_log_bytes_limit(None)
            // The airdrop faucet: a billion SOL, so tests never run it dry.
            .with_lamports(1_000_000_000 * LAMPORTS_PER_SOL);
        // LiteSVM installs `EpochSchedule::default()`, which has warm-up epochs: its epoch and
        // slot index would disagree with the `Clock` this harness warps (fixed 432,000-slot
        // epochs from slot 0), and the program reads both (`execute_buyback` takes the slot
        // index within the epoch from the schedule).
        svm.set_sysvar(&EpochSchedule::without_warmup());
        let so = program_so_path();
        assert!(
            so.exists(),
            "{} not found: build it with programs/epoch/tests/build-sbf.sh (see tests/README.md)",
            so.display()
        );
        svm.add_program_from_file(TEST_PROGRAM_ID, &so)
            .expect("load the Epoch SBF program");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), sol(1_000_000.0))
            .expect("fund the fee payer");
        let mut ctx = Self {
            svm,
            payer,
            wallets: BTreeMap::new(),
        };
        ctx.warp_to_epoch(START_EPOCH);
        ctx
    }

    // ── wallets ──────────────────────────────────────────────────────────

    /// The wallet named `name`, created and funded with `sol` SOL on first use.
    pub fn wallet_with(&mut self, name: &str, sol_amount: f64) -> Pubkey {
        if let Some(k) = self.wallets.get(name) {
            return k.pubkey();
        }
        let k = Keypair::new();
        let key = k.pubkey();
        if sol_amount > 0.0 {
            self.svm.airdrop(&key, sol(sol_amount)).expect("airdrop");
        }
        self.wallets.insert(name.to_string(), k);
        key
    }

    /// The wallet named `name` (100 SOL on first use).
    pub fn wallet(&mut self, name: &str) -> Pubkey {
        self.wallet_with(name, 100.0)
    }

    /// The keypair of a wallet created with [`Self::wallet`].
    #[track_caller]
    pub fn keypair(&self, name: &str) -> &Keypair {
        self.wallets
            .get(name)
            .unwrap_or_else(|| panic!("no wallet named {name}"))
    }

    pub fn key(&self, name: &str) -> Pubkey {
        self.keypair(name).pubkey()
    }

    // ── accounts ─────────────────────────────────────────────────────────

    pub fn account(&self, key: &Pubkey) -> Option<Account> {
        self.svm.get_account(key)
    }

    pub fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.svm.get_account(key).is_some_and(|a| a.lamports > 0)
    }

    /// An Anchor account of the program, deserialized (discriminator checked).
    #[track_caller]
    pub fn get<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let acc = self
            .svm
            .get_account(key)
            .unwrap_or_else(|| panic!("account {key} does not exist"));
        assert_eq!(
            acc.owner, TEST_PROGRAM_ID,
            "account {key} is not owned by the program"
        );
        T::try_deserialize(&mut acc.data.as_slice()).unwrap_or_else(|e| {
            panic!(
                "account {key} does not deserialize as {}: {e}",
                std::any::type_name::<T>()
            )
        })
    }

    /// Send lamports from the fee payer straight to `to` (a donation, simulated
    /// validator revenue, …) without going through the program.
    pub fn transfer(&mut self, to: &Pubkey, lamports: u64) {
        let ix = solana_system_interface::instruction::transfer(&self.payer.pubkey(), to, lamports);
        self.send(&[ix], &[]).expect("transfer");
    }

    pub fn rent_exempt(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    // ── time ─────────────────────────────────────────────────────────────

    pub fn clock(&self) -> Clock {
        self.svm.get_sysvar::<Clock>()
    }

    pub fn epoch(&self) -> u64 {
        self.clock().epoch
    }

    /// Move to the first slot of `epoch`, keeping `Clock` consistent.
    pub fn warp_to_epoch(&mut self, epoch: u64) {
        let mut clock = self.clock();
        let slot = epoch * SLOTS_PER_EPOCH;
        let seconds = (slot.saturating_sub(clock.slot) * 2 / 5) as i64; // 400 ms slots
        clock.slot = slot;
        clock.epoch = epoch;
        clock.leader_schedule_epoch = epoch + 1;
        clock.unix_timestamp += seconds;
        clock.epoch_start_timestamp = clock.unix_timestamp;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    /// Advance `n` epochs (to the first slot of each).
    pub fn advance_epochs(&mut self, n: u64) {
        let e = self.epoch() + n;
        self.warp_to_epoch(e);
    }

    /// Advance `n` slots within the current epoch (or past it; the epoch follows the slot).
    pub fn advance_slots(&mut self, n: u64) {
        let mut clock = self.clock();
        clock.slot += n;
        let epoch = clock.slot / SLOTS_PER_EPOCH;
        if epoch != clock.epoch {
            clock.epoch = epoch;
            clock.leader_schedule_epoch = epoch + 1;
            clock.epoch_start_timestamp = clock.unix_timestamp;
        }
        clock.unix_timestamp += (n * 2 / 5) as i64;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    // ── transactions ─────────────────────────────────────────────────────

    /// Sign with the fee payer plus `signers` and execute.
    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        // A fresh blockhash per transaction: identical instructions sent twice
        // are two transactions, not a duplicate.
        self.svm.expire_blockhash();
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&self.payer.pubkey()),
            &all,
            self.svm.latest_blockhash(),
        );
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(TxOk { meta }),
            Err(FailedTransactionMetadata { err, meta }) => Err(TxErr {
                err,
                logs: meta.logs,
            }),
        }
    }

    /// Send signed by the named wallets.
    pub fn send_as(&mut self, ixs: &[Instruction], names: &[&str]) -> TxResult {
        let keys: Vec<Keypair> = names
            .iter()
            .map(|n| self.keypair(n).insecure_clone())
            .collect();
        let refs: Vec<&Keypair> = keys.iter().collect();
        self.send(ixs, &refs)
    }
}

impl Default for TestContext {
    fn default() -> Self {
        Self::new()
    }
}
