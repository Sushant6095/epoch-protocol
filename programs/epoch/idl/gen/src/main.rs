//! `anchor idl build` without anchor-cli: anchor-cli 1.2 builds the IDL with
//! `anchor_lang_idl::build::IdlBuilder`, which compiles the program's tests
//! with `--features idl-build`, runs `__anchor_private_print_idl` and
//! assembles the printed pieces (then converts module paths, sorts and
//! verifies). This runs the same builder.
//!
//! Usage: `cargo run --release -- <program dir> <out.json>` (scripts/build-idl.sh).
//! Run it from a shell where RUSTUP_TOOLCHAIN is unset: IdlBuilder 0.1.4
//! passes a literal `+{toolchain}` to cargo when it is set.
use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let (Some(program), Some(out)) = (args.next(), args.next()) else {
        anyhow::bail!("usage: epoch-idl-gen <program dir> <out.json>");
    };
    let idl = anchor_lang_idl::build::IdlBuilder::new()
        .program_path(PathBuf::from(program))
        .resolution(true)
        .skip_lint(false)
        .no_docs(false)
        .build()?;
    let mut json = serde_json::to_string_pretty(&idl)?;
    json.push('\n');
    std::fs::write(&out, json)?;
    eprintln!("wrote {out}");
    Ok(())
}
