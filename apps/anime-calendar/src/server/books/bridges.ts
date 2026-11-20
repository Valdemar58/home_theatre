import "server-only";
import { pluginIndex, pluginLang } from "./providers/lnreader";
import { suwa, suwaSources, suwaCapabilities } from "./providers/suwayomi";
import { providerConfig, saveProviderConfig } from "./provider-config";
import { bridgeUrl, repositoryUrl } from "@/lib/manga-sources";

// Управление мостами (TASKS 5.9, карточка «Провайдеры глав», только админ): плагины LNReader — какие включены;
// Suwayomi — репозиторий расширений (пишется и в сам Suwayomi), установка расширений, источники для поиска.

type SExt = { pkgName: string; name: string; lang: string; versionName: string; isInstalled: boolean; hasUpdate: boolean; isNsfw: boolean };

export async function bridgesState() {
  const cfg = providerConfig();
  const plugins = await pluginIndex().then((list) => list.map((p) => ({ id: p.id, name: p.name, lang: pluginLang(p), site: p.site }))).catch(() => null);
  let suwayomi: { up: boolean; version: string | null; extensions: SExt[]; sources: { id: string; name: string; lang: string; nsfw: boolean }[]; error: string | null };
  if (!cfg.suwayomi.url) {
    suwayomi = { up: false, version: null, extensions: [], sources: [], error: null };
  } else try {
    const about = await suwa<{ aboutServer: { version: string } }>(`{ aboutServer { version } }`, undefined, 5000);
    const { modern } = await suwaCapabilities();
    const ext = await suwa<{ extensions: { nodes: SExt[] } }>(`{ extensions { nodes { pkgName name lang versionName isInstalled hasUpdate ${modern ? "" : "isNsfw"} } } }`);
    const sources = (await suwaSources()).map((s) => ({ id: s.id, name: s.displayName, lang: s.lang, nsfw: s.isNsfw }));
    suwayomi = { up: true, version: about.aboutServer.version, extensions: ext.extensions.nodes, sources, error: null };
  } catch (e) {
    suwayomi = { up: false, version: null, extensions: [], sources: [], error: e instanceof Error ? e.message : String(e) };
  }
  return {
    lnreader: { index: cfg.lnreader.index, enabled: cfg.lnreader.plugins, plugins },
    suwayomi: { ...suwayomi, url: cfg.suwayomi.url, repo: cfg.suwayomi.repo, enabled: cfg.suwayomi.sources, languages: cfg.suwayomi.languages },
  };
}

/** Репозиторий расширений: в настройки календаря и в Suwayomi; после — обновить список расширений. */
export async function setSuwayomiRepo(repo: string) {
  repo = repositoryUrl(repo);
  const cfg = providerConfig();
  const { modern } = await suwaCapabilities();
  if (modern) {
    if (!repo) throw new Error("Укажите адрес репозитория");
    await suwa(`mutation ($url: String!) { addExtensionStore(input: { indexUrl: $url }) { __typename } }`, { url: repo }, 120_000);
  } else {
    const legacyRepo = repo.replace(/\/repo\/index\.(?:pb|min\.json|json)$/, "");
    await suwa(`mutation ($repos: [String!]!) { setSettings(input: { settings: { extensionRepos: $repos } }) { settings { extensionRepos } } }`, { repos: legacyRepo ? [legacyRepo] : [] });
  }
  await suwa(`mutation { fetchExtensions(input: {}) { extensions { pkgName } } }`, undefined, 120_000);
  saveProviderConfig({ suwayomi: { ...cfg.suwayomi, repo } });
}

export async function suwayomiExtension(pkgName: string, action: "install" | "uninstall" | "update") {
  await suwa(`mutation ($id: String!, $patch: UpdateExtensionPatchInput!) { updateExtension(input: { id: $id, patch: $patch }) { extension { pkgName isInstalled } } }`,
    { id: pkgName, patch: { [action]: true } }, 180_000);
}

export function setBridges(patch: { plugins?: string[]; index?: string; sources?: string[]; url?: string; languages?: string[] }) {
  const cfg = providerConfig();
  saveProviderConfig({
    lnreader: { index: patch.index?.trim() || cfg.lnreader.index, plugins: patch.plugins ?? cfg.lnreader.plugins },
    suwayomi: { ...cfg.suwayomi, sources: patch.sources ?? cfg.suwayomi.sources,
      url: patch.url === undefined ? cfg.suwayomi.url : patch.url.trim() ? bridgeUrl(patch.url) : "",
      languages: patch.languages?.filter((l) => ["ru", "en", "ja", "ko", "zh", "multi"].includes(l)) ?? cfg.suwayomi.languages },
  });
}
