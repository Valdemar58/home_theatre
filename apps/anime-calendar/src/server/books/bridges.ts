import "server-only";
import { pluginIndex, pluginLang } from "./providers/lnreader";
import { suwa, suwaSources } from "./providers/suwayomi";
import { providerConfig, saveProviderConfig } from "./provider-config";

// Управление мостами (TASKS 5.9, карточка «Провайдеры глав», только админ): плагины LNReader — какие включены;
// Suwayomi — репозиторий расширений (пишется и в сам Suwayomi), установка расширений, источники для поиска.

type SExt = { pkgName: string; name: string; lang: string; versionName: string; isInstalled: boolean; hasUpdate: boolean; isNsfw: boolean };

export async function bridgesState() {
  const cfg = providerConfig();
  const plugins = await pluginIndex().then((list) => list.map((p) => ({ id: p.id, name: p.name, lang: pluginLang(p), site: p.site }))).catch(() => null);
  let suwayomi: { up: boolean; version: string | null; extensions: SExt[]; sources: { id: string; name: string; lang: string; nsfw: boolean }[]; error: string | null };
  try {
    const about = await suwa<{ aboutServer: { version: string } }>(`{ aboutServer { version } }`, undefined, 5000);
    const ext = await suwa<{ extensions: { nodes: SExt[] } }>(`{ extensions { nodes { pkgName name lang versionName isInstalled hasUpdate isNsfw } } }`);
    const sources = (await suwaSources()).map((s) => ({ id: s.id, name: s.displayName, lang: s.lang, nsfw: s.isNsfw }));
    suwayomi = { up: true, version: about.aboutServer.version, extensions: ext.extensions.nodes, sources, error: null };
  } catch (e) {
    suwayomi = { up: false, version: null, extensions: [], sources: [], error: e instanceof Error ? e.message : String(e) };
  }
  return {
    lnreader: { index: cfg.lnreader.index, enabled: cfg.lnreader.plugins, plugins },
    suwayomi: { ...suwayomi, url: cfg.suwayomi.url, repo: cfg.suwayomi.repo, enabled: cfg.suwayomi.sources },
  };
}

/** Репозиторий расширений: в настройки календаря и в Suwayomi; после — обновить список расширений. */
export async function setSuwayomiRepo(repo: string) {
  const cfg = providerConfig();
  saveProviderConfig({ suwayomi: { ...cfg.suwayomi, repo } });
  await suwa(`mutation ($repos: [String!]!) { setSettings(input: { settings: { extensionRepos: $repos } }) { settings { extensionRepos } } }`, { repos: repo ? [repo] : [] });
  await suwa(`mutation { fetchExtensions(input: {}) { extensions { pkgName } } }`, undefined, 120_000);
}

export async function suwayomiExtension(pkgName: string, action: "install" | "uninstall" | "update") {
  await suwa(`mutation ($id: String!, $patch: UpdateExtensionPatchInput!) { updateExtension(input: { id: $id, patch: $patch }) { extension { pkgName isInstalled } } }`,
    { id: pkgName, patch: { [action]: true } }, 180_000);
}

export function setBridges(patch: { plugins?: string[]; index?: string; sources?: string[] }) {
  const cfg = providerConfig();
  saveProviderConfig({
    lnreader: { index: patch.index?.trim() || cfg.lnreader.index, plugins: patch.plugins ?? cfg.lnreader.plugins },
    suwayomi: { ...cfg.suwayomi, sources: patch.sources ?? cfg.suwayomi.sources },
  });
}
