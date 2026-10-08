# Third-party notices

Code in this app that was adapted from third-party source. Libraries installed from npm keep their own licences in
`node_modules`; the skills vendored under `.claude/skills` are listed in `THIRD-PARTY-SKILLS.md`; registry components
(shadcn, ReUI) are listed in `handover/PROVENANCE.md`.

## Meteora fun-launch scaffold

- Source: [MeteoraAg/meteora-invent](https://github.com/MeteoraAg/meteora-invent), `scaffolds/fun-launch`
  (commit `dd77ef3d5aede3f0ff21d566d052097200417f5e`).
- Licence: MIT (the repository's `LICENSE.md`, below). The scaffold's `package.json` says `"license": "ISC"`; the
  repository licence file is MIT, and both are permissive. This notice keeps the MIT text.
- What was adapted (each file says so in its header):

| Our file | From the scaffold | What changed |
| --- | --- | --- |
| `src/components/launch/fun-launch/age.tsx` | `src/lib/format/date.ts` (`formatAge`), `src/components/TokenTable/TxnsTab/CurrentAge.tsx`, the shared clock in `src/lib/environment/date.ts` | No jotai (a small external store); a frozen clock for sample data; Epoch's dash for missing values |
| `src/components/launch/fun-launch/curve-progress.tsx` | `src/components/TokenHeader/BondingCurve.tsx` | Epoch's words (raise, graduates), the raise in SOL, a `progressbar` role, a graduated state |
| `src/components/launch/fun-launch/trades-table.tsx` | `src/components/TokenTable/TxnsTab/columns.tsx` and `TxTable.tsx` | TanStack Table v9 through Epoch's `DataTable`, SOL instead of USD, the venue column, buybacks by the program's escrow labelled, IST times |
| `src/lib/format.ts` (`priceParts`, `fmtPrice`) and `PriceText` in `src/components/data/primitives.tsx` | The notation of `src/components/ui/ReadableNumber` (`index.tsx`, `DigitSubscript.tsx`): a run of zeros written as a subscript count | Re-implemented; no code copied |

```
MIT License

Copyright (c) 2025 Meteora

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## ReUI stepper

- Source: [reui.io](https://reui.io) registry item `styles/base-nova/stepper` (MIT), vendored at
  `src/components/reui/stepper.tsx` and used by `src/components/tx/tx-stepper.tsx`.

## TradingView Lightweight Charts

- `lightweight-charts` is Apache-2.0. Its attribution logo stays on every chart, and the footer links TradingView.

## Earth imagery (`public/earth/*`)
Day, night-lights and cloud maps from NASA Visible Earth (Blue Marble, Black Marble), public domain, as
distributed in the three.js examples (`examples/textures/planets`, MIT). Re-encoded; the cloud map is the
blue channel of `earth_bump_roughness_clouds_4096.jpg`.

## Hero footage (`public/earth/hero.mp4`, `hero.webm`, `hero-poster.jpg`)
NASA, "Earth from Space in 4K, Expedition 65 Edition" (jsc2022m000172, images.nasa.gov), footage from the
International Space Station. NASA imagery is not copyrighted (public domain). Excerpt 32:59-33:04 from the 4K original, colour-graded, slowed 2x, rotated 180
degrees, crossfade-looped and re-encoded. NASA does not endorse Epoch.
