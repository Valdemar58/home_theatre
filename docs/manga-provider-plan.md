# Manga sources and reader improvement plan

## Goal

Configure sources once, then discover a manga across enabled RU, EN and JP sources from its title page. Berserk is the first end-to-end acceptance case. Availability depends on the selected sites; do not promise every manga or report a failed source as an empty catalog.

## Existing foundation

- `server/books/providers/types.ts`: common search, chapter and page interface.
- `server/books/library.ts`: automatic/manual matching, stored links and chapter aggregation. Automatic links currently keep at most three matches per provider; a manual link prevents further automatic searches for that entire provider.
- `providers/suwayomi.ts` and `books/bridges.ts`: existing extension installation and source selection through Suwayomi. Searches use the first page and at most two names; errors are logged and can become indistinguishable from no matches. All extension sources share one provider identity.
- `MangaReader.tsx`: paged and vertical strip modes, RTL/LTR, optional spreads, fit width/height, strip width, stored settings, keyboard, taps, swipes, wheel and dedicated page buttons. Reader audit here is source inspection; visual/device verification remains required.
- Current taps use left/right 30% zones and center advances. Navigation methods and tap zones are not configurable.

## 1. Diagnose Berserk and expose source status

Check the running Suwayomi profile, repository configuration, installed extensions, enabled sources and language filters. Trace Berserk / Берсерк / ベルセルク through search, matching, chapter discovery and page loading. Record whether the failure is source configuration, matching, a network/challenge error, or an external-only chapter.

Show source-level results: searching, found, no match, disabled, unavailable, authentication/challenge required. Allow retry of a single source. Preserve existing chapters on a failed refresh. Do not cache partial failed searches as successful empty matches.

## 2. Make source configuration usable

Extend the existing provider settings rather than adding another engine. Use Suwayomi as the server-side runtime for the Mihon/Tachiyomi extension ecosystem, similar to Tachimanga.

Provide a setup flow: server connection → extension repository → install/update extensions → enable sources → preferred languages and source order → test search. Explain the difference between a repository URL and a manga URL. Show source language, installation/version, health and last successful check. Support RU, EN and JA preferences (`ja` internally, JP in the interface).

Keep repository management admin-only. Validate connection destinations and page proxy targets; extension installation must be an explicit admin action. Never execute extension packages in the browser or Next.js process.

## 3. Improve discovery and matching

Identify an extension source separately from the bridge provider. Migrate existing Suwayomi links without losing progress. Add source/configuration version to search caches and invalidate negative matches when sources change.

Search enabled sources with bounded concurrency, individual deadlines, cancellation and incremental results. Search translated/native names and aliases, with pagination on demand. Match using external identifiers where available, then normalized titles, author/year and format. Show ambiguous candidates for confirmation. Replace the provider-wide three-result limit with source-aware limits. A manual match must not suppress other sources or languages.

Store verified links so users do not paste links for each manga. Retain manual URL/search matching as a fallback. Preserve language, scanlator, volume and chapter labels, including special and nonstandard early chapter numbering. Switching source must not silently mark another chapter read.

## 4. Source selection on the manga page

Provide an Available sources panel with language, source, teams, chapter coverage and health. Default to the user's preferred language/source; expose alternatives when chapters are missing. Show Read / Continue immediately when a readable chapter is available. For official external-only chapters, offer an explicit external link. Preserve the current chapter/page when a reliable cross-source match exists; otherwise ask the user to select a chapter.

## 5. MangaLib-style reader controls

Retain the existing reading modes and add a clear settings drawer with previews:

- Single page, double-page spread and continuous vertical scroll; RTL/LTR independently selectable.
- Fit height/width, strip width, page gaps, background, fullscreen and progress display.
- Independently enable taps, swipes, keyboard and wheel navigation. Buttons always remain accessible.
- Tap layouts: left/right by reading direction, left=previous/right=next, or buttons only. Center toggles controls. Show tap-zone preview and a reset button.
- Arrow keys follow the selected direction; PageDown/Space advance and PageUp/Shift+Space go back where appropriate. Ignore shortcuts while editing fields and avoid turning a page after a swipe or zoom gesture.
- Explicit previous/next chapter controls at boundaries. Continuous scroll within a chapter is existing behavior; optional seamless next-chapter loading requires separate progress and URL handling.
- Save global preferences with per-book overrides. Retain the visible page when switching layout and restore position after images load.

## 6. Verification and delivery order

Ship diagnostics/setup first, source-aware discovery second, reader controls third. Use deterministic tests for aliases, source isolation, partial failures, chapter matching and settings migration. Use browser/device checks for layout, touch, keyboard, spreads and long-strip performance.

Acceptance: configure repositories/sources once; find Berserk automatically in available preferred languages; read its first chapter, advance by both screen sides and buttons, change mode and resume after reload. A broken source must not block healthy sources. Also verify a webtoon, special chapter numbering, external-only chapters, expired image URLs and missing chapters. Live source checks are necessary before calling Berserk fixed.

## References

- Tachimanga extension compatibility: https://tachimanga.app/help/guides/find-repos.html
- Tachimanga repository model: https://tachimanga.app/help/guides/repositories.html
- Suwayomi extension setup: https://github.com/Suwayomi/Suwayomi-Server/blob/master/docs/Getting-Extensions.md
