use anchor_lang::prelude::*;

use crate::{
    constants::{
        BPS_DENOMINATOR, MAX_INDEX_OPERATORS, MAX_INDEX_TOLERANCE_BPS, MAX_INDEX_TOTAL_WEIGHT,
        MIN_INDEX_THRESHOLD_BPS,
    },
    errors::EpochError,
    math::meets_threshold,
};

/// One registered Fee Index operator: the key that signs its votes and its
/// voting weight.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace,
)]
pub struct IndexOperator {
    pub key: Pubkey,
    pub weight: u32,
}

/// The operators that vote on the Solana Fee Index (seeds:
/// `["index_operators", fee_index]`).
///
/// Adapted from jito-foundation/jito-tip-router/program/src/cast_vote.rs
/// (MIT or Apache-2.0): there the voter is a Jito restaking `Operator.voter`
/// and its stake weight comes from per-epoch operator snapshots and weight
/// tables. Epoch has no restaking: the admin registers up to eight voting keys
/// and their weights here, and each ballot copies this registry when a round
/// opens, so a change applies from the next round and never moves a vote in
/// progress.
///
/// Creating the registry points `FeeIndex.publisher` at this PDA, which no key
/// can sign for: from then on a value reaches `FeeIndex` only through a ballot
/// (or `post_index` by the sole operator of a one-operator registry).
#[account]
#[derive(InitSpace)]
pub struct IndexOperators {
    pub fee_index: Pubkey,
    pub bump: u8,
    /// Agreeing weight needed, bps of `total_weight` (rounded-up share).
    pub threshold_bps: u16,
    /// A vote agrees when within this many bps of the weighted median.
    pub tolerance_bps: u16,
    pub operator_count: u8,
    pub total_weight: u64,
    /// The first `operator_count` entries are used, in the order added.
    pub operators: [IndexOperator; MAX_INDEX_OPERATORS],
    pub _reserved: [u8; 64],
}

impl IndexOperators {
    /// The registered operators.
    pub fn active(&self) -> &[IndexOperator] {
        let count = usize::from(self.operator_count).min(MAX_INDEX_OPERATORS);
        &self.operators[..count]
    }

    pub fn position(&self, key: &Pubkey) -> Option<usize> {
        self.active().iter().position(|o| o.key == *key)
    }

    pub fn weight_of(&self, key: &Pubkey) -> Option<u32> {
        self.position(key).map(|i| self.operators[i].weight)
    }

    /// Threshold and tolerance within the program's bounds.
    pub fn check_params(threshold_bps: u16, tolerance_bps: u16) -> Result<()> {
        require!(
            (MIN_INDEX_THRESHOLD_BPS..=BPS_DENOMINATOR as u16).contains(&threshold_bps)
                && tolerance_bps <= MAX_INDEX_TOLERANCE_BPS,
            EpochError::InvalidConsensusParams
        );
        Ok(())
    }

    pub fn add(&mut self, key: Pubkey, weight: u32) -> Result<()> {
        require!(
            self.position(&key).is_none(),
            EpochError::IndexOperatorExists
        );
        let count = usize::from(self.operator_count);
        require!(count < MAX_INDEX_OPERATORS, EpochError::IndexOperatorsFull);
        let total = self.total_with(None, weight)?;
        self.operators[count] = IndexOperator { key, weight };
        self.operator_count += 1;
        self.total_weight = total;
        Ok(())
    }

    /// Removes `key`, keeping the order of the others. Returns its weight.
    pub fn remove(&mut self, key: &Pubkey) -> Result<u32> {
        let at = self
            .position(key)
            .ok_or(error!(EpochError::UnknownIndexOperator))?;
        let count = usize::from(self.operator_count);
        let weight = self.operators[at].weight;
        self.operators.copy_within(at + 1..count, at);
        self.operators[count - 1] = IndexOperator::default();
        self.operator_count -= 1;
        self.total_weight = self
            .total_weight
            .checked_sub(u64::from(weight))
            .ok_or(EpochError::MathOverflow)?;
        Ok(weight)
    }

    /// Sets `key`'s weight. Returns the old weight.
    pub fn set_weight(&mut self, key: &Pubkey, weight: u32) -> Result<u32> {
        let at = self
            .position(key)
            .ok_or(error!(EpochError::UnknownIndexOperator))?;
        let total = self.total_with(Some(at), weight)?;
        let old = self.operators[at].weight;
        self.operators[at].weight = weight;
        self.total_weight = total;
        Ok(old)
    }

    /// Whether `key` may use `post_index` directly: it is the only operator
    /// and its weight meets the threshold (always, for a sole operator; the
    /// check is the ballots' own, so the two paths can never disagree).
    pub fn is_sole_operator(&self, key: &Pubkey) -> bool {
        match self.active() {
            [only] => {
                only.key == *key
                    && meets_threshold(
                        u64::from(only.weight),
                        self.total_weight,
                        self.threshold_bps,
                    )
            }
            _ => false,
        }
    }

    /// Total weight with operator `replacing` (or a new one) at `weight`;
    /// rejects a zero weight and a total above `MAX_INDEX_TOTAL_WEIGHT`.
    fn total_with(&self, replacing: Option<usize>, weight: u32) -> Result<u64> {
        require!(weight > 0, EpochError::InvalidOperatorWeight);
        let others: u64 = self
            .active()
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != replacing)
            .map(|(_, o)| u64::from(o.weight))
            .sum();
        let total = others
            .checked_add(u64::from(weight))
            .ok_or(EpochError::MathOverflow)?;
        require!(
            total <= MAX_INDEX_TOTAL_WEIGHT,
            EpochError::InvalidOperatorWeight
        );
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{DEFAULT_INDEX_THRESHOLD_BPS, DEFAULT_INDEX_TOLERANCE_BPS};

    fn registry() -> IndexOperators {
        IndexOperators {
            fee_index: Pubkey::new_unique(),
            bump: 255,
            threshold_bps: DEFAULT_INDEX_THRESHOLD_BPS,
            tolerance_bps: DEFAULT_INDEX_TOLERANCE_BPS,
            operator_count: 0,
            total_weight: 0,
            operators: [IndexOperator::default(); MAX_INDEX_OPERATORS],
            _reserved: [0; 64],
        }
    }

    #[test]
    fn layout_size() {
        assert_eq!(IndexOperator::INIT_SPACE, 36);
        assert_eq!(8 + IndexOperators::INIT_SPACE, 406);
    }

    #[test]
    fn add_remove_and_reweigh() {
        let mut r = registry();
        let (a, b, c) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        r.add(a, 1).unwrap();
        r.add(b, 2).unwrap();
        r.add(c, 3).unwrap();
        assert_eq!(r.total_weight, 6);
        assert!(r.add(b, 1).is_err(), "duplicate");
        assert_eq!(r.remove(&b).unwrap(), 2);
        assert_eq!(
            r.active(),
            &[
                IndexOperator { key: a, weight: 1 },
                IndexOperator { key: c, weight: 3 }
            ]
        );
        assert_eq!(r.operators[2], IndexOperator::default());
        assert_eq!(r.total_weight, 4);
        assert!(r.remove(&b).is_err(), "already removed");
        assert_eq!(r.set_weight(&c, 9).unwrap(), 3);
        assert_eq!(r.total_weight, 10);
        assert!(r.set_weight(&b, 1).is_err(), "unknown");
        assert!(r.set_weight(&a, 0).is_err(), "zero weight");
    }

    #[test]
    fn caps() {
        let mut r = registry();
        for _ in 0..MAX_INDEX_OPERATORS {
            r.add(Pubkey::new_unique(), 1_000).unwrap();
        }
        assert!(r.add(Pubkey::new_unique(), 1).is_err(), "full");
        let first = r.operators[0].key;
        assert!(r.set_weight(&first, 3_001).is_err(), "total above 10,000");
        r.set_weight(&first, 3_000).unwrap();
        assert_eq!(r.total_weight, MAX_INDEX_TOTAL_WEIGHT);
        let mut r = registry();
        assert!(r.add(Pubkey::new_unique(), 10_001).is_err());
        assert!(r.add(Pubkey::new_unique(), 0).is_err());
    }

    #[test]
    fn sole_operator_shortcut() {
        let mut r = registry();
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        assert!(!r.is_sole_operator(&a), "empty registry");
        r.add(a, 5).unwrap();
        assert!(r.is_sole_operator(&a));
        assert!(!r.is_sole_operator(&b));
        r.add(b, 1).unwrap();
        assert!(!r.is_sole_operator(&a), "two operators: vote instead");
    }

    #[test]
    fn params() {
        assert!(IndexOperators::check_params(6_667, 100).is_ok());
        assert!(IndexOperators::check_params(5_001, 0).is_ok());
        assert!(IndexOperators::check_params(10_000, 1_000).is_ok());
        assert!(IndexOperators::check_params(5_000, 100).is_err());
        assert!(IndexOperators::check_params(10_001, 100).is_err());
        assert!(IndexOperators::check_params(6_667, 1_001).is_err());
    }
}
