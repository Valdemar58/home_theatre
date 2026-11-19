# Manga sources

Configure once in Settings → extension bridges → Suwayomi:

1. Connect to `http://suwayomi:4567` inside Docker (the `suwayomi` Compose profile must be enabled).
2. Add an extension repository. Both a GitHub repository URL and its Tachimanga `index.pb` URL are accepted. Tested repository: `https://github.com/keiyoushi/extensions/raw/repo/index.pb`.
3. Install extensions for the sites you use, then explicitly enable their sources. Installing an extension does not enable its sources automatically.
4. Arrange source priority with ↑ and select preferred languages in order. JP is stored as `ja`.
5. Open a manga. Matching titles and aliases are searched automatically. The Available sources panel shows results, failures and individual retry/search actions. Manual matching has search pagination and does not prevent discovery in other sources.

## Reader

The settings button opens a floating panel. Choose pages or a continuous vertical strip, RTL/LTR, single pages or automatic spreads on wide screens, fit height/width, strip width, gaps and background. Preferences are stored in this browser; enable the per-book switch for layout/navigation overrides.

Left/right edge taps follow reading direction by default. Choose fixed left=previous/right=next or buttons only. The center toggles tools. Page buttons remain available. Swipes, keyboard and wheel page turns can be disabled separately. Arrow keys follow reading direction; PageDown/Space advance, PageUp/Shift+Space go back. Strip mode scrolls within the chapter; chapter buttons cross chapter boundaries. Seamless automatic loading of the next chapter is not enabled.

The reader restores saved position only for the same provider and chapter reference. A different translation opens from its beginning instead of guessing a page match. Use Update pages if upstream page links expire. Existing reading progress and manual provider links retain their identifiers.

## Verified on 2026-11-01

- Running Suwayomi: v2.4.2366. Modern extension stores and chapter fetch API supported; legacy extensionRepos/fetchChapters path retained for older servers.
- Keiyoushi store loaded and extensions installed successfully.
- Weeb Central (EN): Berserk found automatically, 403 chapters; first chapter returned 92 pages and rendered in the calendar reader.
- Rawkuma (JP): Berserk found, 30 chapters (partial coverage).
- ReadManga and MintManga (RU): configured and searchable, but their tested search did not return the original Berserk. Other similarly named titles were not automatically linked.
- MangaLib extension hit a WebView timeout in this server environment, so it is installed but not enabled. The native MangaLib provider remains available; adult catalog access may require its login token.

Sources can change or fail independently. Errors are distinct from empty results, saved chapters survive refresh errors, and failed extension requests do not trip the bridge-wide circuit breaker for other sources. Source metadata is stored separately from existing reading positions.

## Checks

Run `npm run typecheck` and `npm test` on a supported Node 22 runtime with SQLite enabled. Docker uses Node 22 Alpine. The full test suite also needs the repository's `profiles.toml` at the path expected by `src/server/ru/profiles.test.ts`.

Repository documentation: https://keiyoushi.github.io/docs/guides/getting-started
Suwayomi setup: https://github.com/Suwayomi/Suwayomi-Server/blob/master/docs/Getting-Extensions.md
