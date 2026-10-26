/** Параметры ForceAtlas2 — общие для раскладки на сервере и «живой» физики в браузере. */
export const FA2_SETTINGS = <T extends object>(base: T) => ({ ...base, adjustSizes: false });

/**
 * Вес ребра для раскладки: внутри кластера тянет сильнее, между кластерами — слабее.
 * Так сообщества ложатся отдельными «островами», как в Obsidian (без этого цвета перемешаны по всему диску).
 */
export const layoutWeight = (weight: number, sameCluster: boolean) => weight * (sameCluster ? 6 : 0.3);
